// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateGatewayCache, loadGateway, type Model } from './gatewayClient';
import { useMediaCatalog } from './useMediaCatalog';
import { guestMediaCatalog } from './guestMediaCatalog';
import { resetAccountSummaryCacheForTest, useAccountSummary } from './AccountSettings';
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
});

describe('useAccountSummary in-flight deduplication', () => {
  it('deduplicates concurrent account/summary requests across multiple mounted callers (and StrictMode)', async () => {
    resetAccountSummaryCacheForTest();
    let resolveResponse!: (res: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { resolveResponse = resolve; }));
    vi.stubGlobal('fetch', fetcher);

    let firstState: ReturnType<typeof useAccountSummary> | undefined;
    let secondState: ReturnType<typeof useAccountSummary> | undefined;
    function First() { firstState = useAccountSummary(); return null; }
    function Second() { secondState = useAccountSummary(); return null; }

    await act(async () => {
      root.render(<><First /><Second /></>);
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
});
