// @vitest-environment happy-dom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateGatewayCache, loadGateway, setGatewayCacheEnabledForTest, type Model } from './gatewayClient';
import { useMediaCatalog } from './useMediaCatalog';
import { guestMediaCatalog } from './guestMediaCatalog';
import { publishSignedOutAccountSummary, resetAccountSummaryCacheForTest, useAccountSummary } from './AccountSettings';
import { AUTH_RECOVERY_EVENT } from './authRecoveryStore';
import { useProviderDirectory } from './useProviderDirectory';
import { clearPrivateSwrCache, getPrivateSwrIdentity, setPrivateSwrIdentity } from './swrCache';
import { WorkspaceChromeContext, type WorkspaceChrome } from './WorkspaceChromeContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  invalidateGatewayCache();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  invalidateGatewayCache();
});

const liveModel: Model = {
  id: 'opendesign:live-model',
  provider: 'opendesign',
  modelId: 'live-model',
  label: 'Live Model',
  modality: 'image',
  source: 'builtin',
  mode: 'text-to-image',
};

function makeChrome(overrides: Partial<WorkspaceChrome>): WorkspaceChrome {
  return {
    workspace: { authRequired: Boolean(overrides.guestMode) } as WorkspaceChrome['workspace'],
    switchingDisabled: false,
    guestMode: false,
    authResolving: false,
    saveState: '',
    openLibrary: vi.fn(),
    openConnections: vi.fn(),
    openModelSettings: vi.fn(),
    openHome: vi.fn(),
    openAssets: vi.fn(),
    assetsOpen: false,
    openSkills: vi.fn(),
    skillsOpen: false,
    toggleSidebar: vi.fn(),
    sidebarOpen: false,
    navigationCollapsed: false,
    registerEditor: vi.fn(),
    beforeViewChange: async () => {},
    ...overrides,
  };
}

describe('loadGateway legacy fallback guards', () => {
  it('does not fall back to models/capabilities or models?offset=0 when primary endpoints return 401', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      return Response.json({ error: 'Authentication required', code: 'UNAUTHORIZED' }, { status: 401 });
    }));

    await expect(loadGateway()).rejects.toMatchObject({ status: 401 });
    expect(requestedUrls).toEqual(['/motion-api/models/status', '/motion-api/models/catalog']);
  });

  it('does not fall back to legacy endpoints on 500 errors', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      return Response.json({ error: 'Internal error' }, { status: 500 });
    }));

    await expect(loadGateway()).rejects.toMatchObject({ status: 500 });
    expect(requestedUrls).toEqual(['/motion-api/models/status', '/motion-api/models/catalog']);
  });

  it('falls back to models/capabilities and models?offset=0 when primary endpoints return 404', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      if (url.endsWith('/models/status') || url.endsWith('/models/catalog')) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      if (url.endsWith('/models/capabilities')) {
        return Response.json({ providers: [{ id: 'codex', available: true }], routes: {} });
      }
      if (url.includes('/models?offset=0')) {
        return Response.json({ models: [liveModel], nextOffset: null });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const result = await loadGateway();
    expect(result.models).toEqual([liveModel]);
    expect(result.status.providers).toEqual([{ id: 'codex', available: true }]);
    expect(requestedUrls).toEqual([
      '/motion-api/models/status',
      '/motion-api/models/catalog',
      '/motion-api/models/capabilities',
      '/motion-api/models?offset=0',
    ]);
  });
});

describe('useMediaCatalog guest and auth-resolving behavior', () => {
  it('skips all gateway requests in guestMode and returns guestMediaCatalog immediately', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    let latest: ReturnType<typeof useMediaCatalog> | undefined;
    function Probe() {
      latest = useMediaCatalog(true);
      return null;
    }

    await act(async () => {
      root.render(
        <WorkspaceChromeContext.Provider value={makeChrome({ guestMode: true })}>
          <Probe />
        </WorkspaceChromeContext.Provider>,
      );
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(latest?.failed).toBe(false);
    expect(latest?.catalog).toBe(guestMediaCatalog);
  });

  it('waits while authResolving is true and never calls gateway endpoints if session resolves as guest', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    let latest: ReturnType<typeof useMediaCatalog> | undefined;
    function Probe() {
      latest = useMediaCatalog(true);
      return null;
    }

    await act(async () => {
      root.render(
        <WorkspaceChromeContext.Provider value={makeChrome({ guestMode: false, authResolving: true })}>
          <Probe />
        </WorkspaceChromeContext.Provider>,
      );
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(latest?.catalog).toBeUndefined();
    expect(latest?.failed).toBe(false);

    await act(async () => {
      root.render(
        <WorkspaceChromeContext.Provider value={makeChrome({ guestMode: true, authResolving: false })}>
          <Probe />
        </WorkspaceChromeContext.Provider>,
      );
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(latest?.catalog).toBe(guestMediaCatalog);
    expect(latest?.failed).toBe(false);
  });

  it('loads the live gateway catalog once authResolving finishes as signed-in', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      if (url.endsWith('/models/status')) return Response.json({ providers: [{ id: 'opendesign', available: true }], routes: {} });
      if (url.endsWith('/models/catalog')) return Response.json({ models: [liveModel], mode: 'opendesign' });
      throw new Error(`Unexpected request: ${url}`);
    }));

    let latest: ReturnType<typeof useMediaCatalog> | undefined;
    function Probe() {
      latest = useMediaCatalog(true);
      return null;
    }

    await act(async () => {
      root.render(
        <WorkspaceChromeContext.Provider value={makeChrome({ guestMode: false, authResolving: true })}>
          <Probe />
        </WorkspaceChromeContext.Provider>,
      );
    });
    expect(requestedUrls).toEqual([]);

    await act(async () => {
      root.render(
        <WorkspaceChromeContext.Provider value={makeChrome({ guestMode: false, authResolving: false })}>
          <Probe />
        </WorkspaceChromeContext.Provider>,
      );
    });
    expect(requestedUrls).toEqual(['/motion-api/models/status', '/motion-api/models/catalog']);
    expect(latest?.failed).toBe(false);
    expect(latest?.catalog?.models).toEqual([liveModel]);
  });

  it('degrades gracefully to guestMediaCatalog on 401 without calling legacy endpoints, while still flagging 500 failures', async () => {
    const requestedUrls: string[] = [];
    let status = 401;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      return Response.json({ error: status === 401 ? 'Unauthorized' : 'Server error' }, { status });
    }));

    let latest: ReturnType<typeof useMediaCatalog> | undefined;
    function Probe() {
      latest = useMediaCatalog(true);
      return null;
    }

    await act(async () => {
      root.render(<Probe />);
    });
    expect(requestedUrls).toEqual(['/motion-api/models/status', '/motion-api/models/catalog']);
    expect(latest?.failed).toBe(false);
    expect(latest?.catalog).toBe(guestMediaCatalog);

    status = 500;
    requestedUrls.length = 0;
    await act(async () => {
      latest?.retry();
    });
    expect(requestedUrls).toEqual(['/motion-api/models/status', '/motion-api/models/catalog']);
    expect(latest?.failed).toBe(true);
    expect(latest?.catalog).toBeUndefined();
  });

  it('invalidates cached and in-flight gateway responses on motion:account-changed and refreshes mounted consumers', async () => {
    const modelA: Model = { ...liveModel, id: 'opendesign:ws-a-model', modelId: 'ws-a-model', label: 'Workspace A Model' };
    const modelB: Model = { ...liveModel, id: 'opendesign:ws-b-model', modelId: 'ws-b-model', label: 'Workspace B Model' };

    const deferredA = Promise.withResolvers<Response>();
    let callBatch = 0;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/models/status')) {
        return Promise.resolve(Response.json({ providers: [], agents: [], routes: {}, capabilities: [] }));
      }
      callBatch++;
      if (callBatch === 1) return deferredA.promise;
      return Promise.resolve(Response.json({ models: [modelB], mode: 'opendesign' }));
    }));

    let latest: ReturnType<typeof useMediaCatalog> | undefined;
    function Probe() {
      latest = useMediaCatalog(true);
      return null;
    }

    await act(async () => {
      root.render(
        <WorkspaceChromeContext.Provider value={makeChrome({ guestMode: false, authResolving: false })}>
          <Probe />
        </WorkspaceChromeContext.Provider>,
      );
    });
    expect(callBatch).toBe(1);

    // Account changes while Workspace A's catalog request is still in flight.
    await act(async () => {
      window.dispatchEvent(new Event('motion:account-changed'));
      await Promise.resolve();
    });
    expect(callBatch).toBe(2);
    expect(latest?.catalog?.models).toEqual([modelB]);

    // Late response from Workspace A must be ignored and must not overwrite Workspace B.
    await act(async () => {
      deferredA.resolve(Response.json({ models: [modelA], mode: 'opendesign' }));
      await Promise.resolve();
    });
    expect(latest?.catalog?.models).toEqual([modelB]);
  });

  it('invalidates the 5-second loadGateway TTL cache on motion:account-changed and clears useProviderDirectory synchronously', async () => {
    setGatewayCacheEnabledForTest(true);
    try {
      const modelA: Model = { ...liveModel, id: 'opendesign:ttl-a', modelId: 'ttl-a', label: 'TTL A' };
      const modelB: Model = { ...liveModel, id: 'opendesign:ttl-b', modelId: 'ttl-b', label: 'TTL B' };
      let workspace: 'A' | 'B' = 'A';
      const fetcher = vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/models/status')) {
          return Response.json({
            providers: [{ id: 'opendesign', label: 'OpenDesign', protocol: 'account', category: 'account', kinds: ['image'], configured: true, enabled: true, available: true, plan: workspace === 'A' ? 'pro' : 'free' }],
            agents: [],
            routes: {},
            capabilities: [],
          });
        }
        return Response.json({ models: [workspace === 'A' ? modelA : modelB], mode: 'opendesign', defaults: {} });
      });
      vi.stubGlobal('fetch', fetcher);

      const first = await loadGateway();
      expect(first.models).toEqual([modelA]);
      // Within 5s TTL, repeated call serves cached result without fetching.
      const cached = await loadGateway();
      expect(cached.models).toEqual([modelA]);
      expect(fetcher).toHaveBeenCalledTimes(2);

      // Account change invalidates the 5s TTL cache so the next call fetches Workspace B.
      workspace = 'B';
      window.dispatchEvent(new Event('motion:account-changed'));
      const second = await loadGateway();
      expect(second.models).toEqual([modelB]);
      expect(fetcher).toHaveBeenCalledTimes(4);

      // Verify useProviderDirectory clears already-visible Workspace A data synchronously on account change,
      // discards a late pending Workspace A refresh arriving AFTER Workspace B loads, and suppresses stale
      // Workspace A 503 AUTH_UNAVAILABLE recovery notices over healthy Workspace B.
      const pendingARefreshCatalog = Promise.withResolvers<Response>();
      const pendingARefreshStatus = Promise.withResolvers<Response>();
      const pendingBCatalog = Promise.withResolvers<Response>();
      let catalogBatch = 0;
      let statusBatch = 0;
      vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/models/status')) {
          statusBatch++;
          if (statusBatch === 1) return Promise.resolve(Response.json({ providers: [{ id: 'opendesign', plan: 'pro' }], agents: [], routes: {}, capabilities: [] }));
          if (statusBatch === 2) return pendingARefreshStatus.promise;
          return Promise.resolve(Response.json({ providers: [{ id: 'opendesign', plan: 'free' }], agents: [], routes: {}, capabilities: [] }));
        }
        catalogBatch++;
        if (catalogBatch === 1) return Promise.resolve(Response.json({ models: [modelA], mode: 'opendesign', defaults: { image: modelA.id } }));
        if (catalogBatch === 2) return pendingARefreshCatalog.promise;
        return pendingBCatalog.promise;
      }));

      const recoveryEvents: Event[] = [];
      const onRecovery = (event: Event) => { recoveryEvents.push(event); };
      window.addEventListener(AUTH_RECOVERY_EVENT, onRecovery);
      try {
        let dirState: ReturnType<typeof useProviderDirectory> | undefined;
        function DirectoryProbe() {
          dirState = useProviderDirectory();
          return null;
        }
        await act(async () => { root.render(<DirectoryProbe />); });
        expect(dirState?.data?.billing?.plan).toBe('pro');
        expect(dirState?.data?.models.map(m => m.id)).toEqual([modelA.id]);

        // Start a refresh in Workspace A that stays in flight while Workspace A's data is already visible.
        await act(async () => { dirState?.refresh(); });
        expect(catalogBatch).toBe(2);
        expect(dirState?.data?.billing?.plan).toBe('pro');

        // Account change immediately clears already-visible Workspace A data while Workspace B is still pending.
        await act(async () => { window.dispatchEvent(new Event('motion:account-changed')); });
        expect(catalogBatch).toBe(3);
        expect(dirState?.data).toBeNull();

        // Workspace B loads cleanly.
        await act(async () => {
          pendingBCatalog.resolve(Response.json({ models: [modelB], mode: 'opendesign', defaults: { image: modelB.id } }));
          await new Promise(resolve => setTimeout(resolve, 0));
        });
        expect(dirState?.data?.billing?.plan).toBe('free');
        expect(dirState?.data?.models.map(m => m.id)).toEqual([modelB.id]);

        // Workspace A's pending refresh resolves late with 503 AUTH_UNAVAILABLE: must NOT overwrite Workspace B
        // and must NOT emit a global auth-recovery banner over healthy Workspace B.
        await act(async () => {
          pendingARefreshCatalog.resolve(Response.json({ code: 'AUTH_UNAVAILABLE', error: 'Auth backend unavailable' }, { status: 503 }));
          pendingARefreshStatus.resolve(Response.json({ providers: [{ id: 'opendesign', plan: 'pro' }], agents: [], routes: {}, capabilities: [] }));
          await new Promise(resolve => setTimeout(resolve, 0));
        });
        expect(dirState?.data?.billing?.plan).toBe('free');
        expect(dirState?.data?.models.map(m => m.id)).toEqual([modelB.id]);
        expect(dirState?.error).toBe(false);
        expect(recoveryEvents).toHaveLength(0);
      } finally {
        window.removeEventListener(AUTH_RECOVERY_EVENT, onRecovery);
      }
    } finally {
      setGatewayCacheEnabledForTest(null);
      invalidateGatewayCache();
    }
  });
});

describe('useAccountSummary in-flight deduplication', () => {
  it('deduplicates concurrent account/summary requests across multiple mounted callers under StrictMode', async () => {
    resetAccountSummaryCacheForTest();
    let resolveResponse!: (res: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { resolveResponse = resolve; }));
    vi.stubGlobal('fetch', fetcher);

    let firstState: ReturnType<typeof useAccountSummary> | undefined;
    let secondState: ReturnType<typeof useAccountSummary> | undefined;
    function First() { firstState = useAccountSummary(); return null; }
    function Second() { secondState = useAccountSummary(); return null; }

    await act(async () => {
      root.render(<StrictMode><First /><Second /></StrictMode>);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveResponse(Response.json({ error: 'Authentication required' }, { status: 401 }));
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(firstState?.account?.state).toBe('signed-out');
    expect(secondState?.account?.state).toBe('signed-out');
    expect(firstState?.error).toBe(false);
    expect(secondState?.error).toBe(false);
    resetAccountSummaryCacheForTest();
  });

  it('drops pre-logout in-flight summary responses on motion:account-changed and starts fresh for forced billing refreshes', async () => {
    resetAccountSummaryCacheForTest();
    clearPrivateSwrCache();
    setPrivateSwrIdentity({ userId: 'u1', workspaceId: 'ws-a' });

    const preLogout = Promise.withResolvers<Response>();
    const postLogout = Promise.withResolvers<Response>();
    const oldBilling = Promise.withResolvers<Response>();
    const newBilling = Promise.withResolvers<Response>();
    const pendingQueue = [preLogout.promise, postLogout.promise, oldBilling.promise, newBilling.promise];
    const fetcher = vi.fn(() => pendingQueue.shift()!);
    vi.stubGlobal('fetch', fetcher);

    let firstState: ReturnType<typeof useAccountSummary> | undefined;
    let secondState: ReturnType<typeof useAccountSummary> | undefined;
    function First() { firstState = useAccountSummary(); return null; }
    function Second() { secondState = useAccountSummary(); return null; }

    await act(async () => {
      root.render(<><First /><Second /></>);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Header sign-out clears private cache and dispatches motion:account-changed while request #1 is pending.
    await act(async () => {
      clearPrivateSwrCache();
      window.dispatchEvent(new Event('motion:account-changed'));
    });
    // Both callers share ONE fresh post-logout summary fetch instead of rejoining request #1.
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Pre-logout 200 arrives late and must be discarded (must NOT republish signed-in or restore ws-a identity).
    await act(async () => {
      preLogout.resolve(Response.json({
        authenticated: true,
        authMode: 'oidc',
        user: { id: 'u1', email: 'ada@example.test', displayName: 'Ada' },
        activeWorkspace: { id: 'ws-a', slug: 'ws-a', name: 'Workspace A', role: 'owner' },
      }));
      await Promise.resolve();
    });
    expect(firstState?.account).toBeNull();
    expect(getPrivateSwrIdentity()).toBeNull();

    await act(async () => {
      postLogout.resolve(Response.json({ error: 'Authentication required' }, { status: 401 }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(firstState?.account?.state).toBe('signed-out');
    expect(secondState?.account?.state).toBe('signed-out');

    // A forced billing refresh (e.g., after workspace switch) must NOT reuse an already in-flight billing refresh.
    let refreshOld!: Promise<void>;
    let refreshNew!: Promise<void>;
    await act(async () => {
      refreshOld = firstState!.refresh(true);
      refreshNew = firstState!.refresh(true, { force: true });
    });
    expect(fetcher).toHaveBeenCalledTimes(4);

    await act(async () => {
      newBilling.resolve(Response.json({
        authenticated: true,
        authMode: 'oidc',
        user: { id: 'u1', email: 'ada@example.test', displayName: 'Ada' },
        activeWorkspace: { id: 'ws-b', slug: 'ws-b', name: 'Workspace B', role: 'owner' },
      }));
      oldBilling.resolve(Response.json({
        authenticated: true,
        authMode: 'oidc',
        user: { id: 'u1', email: 'ada@example.test', displayName: 'Ada' },
        activeWorkspace: { id: 'ws-a', slug: 'ws-a', name: 'Workspace A', role: 'owner' },
      }));
      await Promise.all([refreshOld, refreshNew]);
    });
    expect(firstState?.account?.activeWorkspace?.id).toBe('ws-b');
    expect(getPrivateSwrIdentity()).toBe('u1:ws-b');

    // Header logout publishes signed-out immediately so a 503 on post-logout summary refresh never leaves ws-b visible.
    fetcher.mockImplementationOnce(async () => Response.json({ error: 'Service unavailable' }, { status: 503 }));
    await act(async () => {
      clearPrivateSwrCache();
      publishSignedOutAccountSummary();
      window.dispatchEvent(new Event('motion:account-changed'));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(firstState?.account?.state).toBe('signed-out');
    expect(firstState?.account?.activeWorkspace).toBeUndefined();
    resetAccountSummaryCacheForTest();
    clearPrivateSwrCache();
  });
});
