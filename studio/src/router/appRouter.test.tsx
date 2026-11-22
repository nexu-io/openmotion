// @vitest-environment happy-dom
import { StrictMode, act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider, useLocation, useMatches, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StudioRouterProvider,
  createAppRouter,
  type AppRouteHandle,
} from './createAppRouter';
import { KeepAliveSlot, useKeepAliveVisited } from './KeepAliveOutlet';
import { useWorkspaceBlocker } from './useWorkspaceBlocker';
import type { WorkspaceRouteId } from './routeRegistry';
import {
  readLocationWorkspaceSource,
  restoreWorkspaceSource,
  workspaceHistoryIndex,
  writeWorkspaceHistory,
} from '../utils/workspaceHistory';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  history.replaceState(null, '', '/');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

describe('createAppRouter semantic route handles', () => {
  const cases: readonly [string, WorkspaceRouteId, boolean, boolean][] = [
    ['/explore', 'explore', true, true],
    ['/explore/product-films', 'explore', true, true],
    ['/create/text-to-image', 'studio', false, true],
    ['/motion', 'motion', false, true],
    ['/cinema', 'cinema', false, true],
    ['/cinema/text-to-video', 'studio', false, true],
    ['/design', 'design', false, true],
    ['/design/prototype', 'design', false, true],
    ['/design/projects/design-1', 'design', false, true],
    ['/sound', 'studio', false, true],
    ['/sound/speech', 'studio', false, true],
    ['/scenarios', 'scenarios', false, true],
    ['/scenarios/launch-video', 'scenario', false, true],
    ['/game', 'game', false, true],
    ['/skills', 'skills', false, true],
    ['/skills/editorial-poster', 'skills', false, true],
    ['/models/veo-3', 'model-overview', false, true],
    ['/models/hub/gemini-4', 'model-hub', false, true],
    ['/assets', 'assets', true, true],
    ['/assets/asset-1', 'assets', true, true],
    ['/brand-kit', 'brand-kit', false, true],
    ['/brand-kit/mine', 'brand-kit', false, true],
    ['/settings', 'settings', false, true],
    ['/settings/providers', 'settings', false, true],
    ['/mcp-setup', 'mcp', false, true],
    ['/mcp-setup/claude', 'mcp', false, true],
    ['/templates', 'templates', false, true],
    ['/editor', 'editor', true, false],
    ['/editor/proj-123', 'editor', true, false],
  ];

  it.each(cases)(
    'matches %s with handle id=%s keepAlive=%s standalone=%s',
    async (pathname, expectedId, expectedKeepAlive, expectedStandalone) => {
      let leafHandle: AppRouteHandle | undefined;
      function Inspector() {
        const matches = useMatches();
        leafHandle = matches.at(-1)?.handle as AppRouteHandle | undefined;
        return null;
      }

      const router = createAppRouter(<Inspector />, {
        memory: true,
        initialEntries: [pathname],
      });
      try {
        await act(async () => root.render(<RouterProvider router={router} />));
        expect(leafHandle).toMatchObject({
          id: expectedId,
          keepAlive: expectedKeepAlive,
          standalone: expectedStandalone,
        });
      } finally {
        router.dispose();
      }
    },
  );
});

describe('KeepAliveSlot and useKeepAliveVisited', () => {
  it('retains keepAlive routes with hidden/inert while unmounting non-keepAlive routes, and does not eagerly mount explore on root editor URL', async () => {
    let setActive!: (id: WorkspaceRouteId) => void;
    function Harness() {
      const [activeId, setActiveId] = useState<WorkspaceRouteId>('editor');
      setActive = setActiveId;
      const visited = useKeepAliveVisited(activeId);
      return (
        <>
          <KeepAliveSlot routeId="explore" active={activeId === 'explore'} visited={visited} className="slot-explore">
            <input aria-label="Explore filter" defaultValue="initial" />
          </KeepAliveSlot>
          <KeepAliveSlot routeId="assets" active={activeId === 'assets'} visited={visited} className="slot-assets">
            <input aria-label="Assets filter" defaultValue="initial" />
          </KeepAliveSlot>
          <KeepAliveSlot routeId="settings" active={activeId === 'settings'} visited={visited} className="slot-settings">
            <input aria-label="Settings input" defaultValue="initial" />
          </KeepAliveSlot>
        </>
      );
    }

    await act(async () =>
      root.render(
        <StudioRouterProvider memory initialEntries={['/?project=first#project/first']}>
          <Harness />
        </StudioRouterProvider>,
      ),
    );

    // Cold-loading editor at `/` must not eagerly mount Explore or Assets.
    expect(container.querySelector('.slot-explore')).toBeNull();
    expect(container.querySelector('.slot-assets')).toBeNull();
    expect(container.querySelector('.slot-settings')).toBeNull();

    // Visit Explore and type into it.
    await act(async () => setActive('explore'));
    const exploreSlot = container.querySelector<HTMLElement>('.slot-explore')!;
    expect(exploreSlot.hidden).toBe(false);
    const exploreInput = container.querySelector<HTMLInputElement>('[aria-label="Explore filter"]')!;
    exploreInput.value = 'kept-explore';

    // Visit Settings (non-KeepAlive) — Explore stays mounted but hidden + inert.
    await act(async () => setActive('settings'));
    expect(exploreSlot.hidden).toBe(true);
    expect(exploreSlot.getAttribute('aria-hidden')).toBe('true');
    expect(exploreSlot.inert).toBe(true);
    const settingsInput = container.querySelector<HTMLInputElement>('[aria-label="Settings input"]')!;
    settingsInput.value = 'ephemeral';

    // Switch to Assets — Settings must unmount, Explore stays preserved.
    await act(async () => setActive('assets'));
    expect(container.querySelector('.slot-settings')).toBeNull();
    expect(container.querySelector('[aria-label="Explore filter"]')).toBe(exploreInput);
    expect(exploreInput.value).toBe('kept-explore');
    const assetsSlot = container.querySelector<HTMLElement>('.slot-assets')!;
    expect(assetsSlot.hidden).toBe(false);

    // Return to Settings — fresh input mounted (non-KeepAlive).
    await act(async () => setActive('settings'));
    expect(assetsSlot.hidden).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Settings input"]')?.value).toBe('initial');
  });
});

describe('useWorkspaceBlocker', () => {
  it('blocks rejected cross-project POP navigation without dropping history stack and proceeds once saves succeed', async () => {
    let shouldFail = true;
    const onError = vi.fn();
    const onProceed = vi.fn();
    let nav!: ReturnType<typeof useNavigate>;
    let currentSearch = '';

    function GuardHarness() {
      const loc = useLocation();
      nav = useNavigate();
      currentSearch = loc.search;
      const actingRef = useRef(false);
      useWorkspaceBlocker({
        enabled: true,
        actingRef,
        waitForSaves: async () => {
          if (shouldFail) throw new Error('Unsaved edit');
        },
        onBlockedError: onError,
        onProjectChangeProceed: onProceed,
      });
      return <div data-search={loc.search} />;
    }

    await act(async () =>
      root.render(
        <StudioRouterProvider memory initialEntries={['/?session=s1&project=p1#project/p1']}>
          <GuardHarness />
        </StudioRouterProvider>,
      ),
    );

    await act(async () => {
      void nav('/?session=s2&project=p2#project/p2');
    });
    expect(currentSearch).toBe('?session=s2&project=p2');

    // Attempt Back while save rejects — must stay on p2 and surface error.
    await act(async () => {
      void nav(-1);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(currentSearch).toBe('?session=s2&project=p2');
    expect(onError).toHaveBeenCalledWith('Unsaved edit');
    expect(onProceed).not.toHaveBeenCalled();

    // Allow save to succeed and retry Back — must move to p1 and notify proceed after commit.
    shouldFail = false;
    await act(async () => {
      void nav(-1);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(currentSearch).toBe('?session=s1&project=p1');
    expect(onError).toHaveBeenLastCalledWith(null);
    expect(onProceed).toHaveBeenCalledTimes(1);

    // Forward destination (p2) is still preserved.
    await act(async () => {
      void nav(1);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(currentSearch).toBe('?session=s2&project=p2');
  });

  it('cancels an older pending blocked POP when another navigation commits first', async () => {
    let resolveSave!: () => void;
    const onProceed = vi.fn();
    let nav!: ReturnType<typeof useNavigate>;
    let currentSearch = '';

    function PendingGuardHarness() {
      const loc = useLocation();
      nav = useNavigate();
      currentSearch = loc.search;
      const actingRef = useRef(false);
      useWorkspaceBlocker({
        enabled: true,
        actingRef,
        waitForSaves: () => new Promise<void>(resolve => { resolveSave = resolve; }),
        onBlockedError: () => {},
        onProjectChangeProceed: onProceed,
      });
      return null;
    }

    await act(async () =>
      root.render(
        <StudioRouterProvider memory initialEntries={['/?session=s1&project=p1#project/p1']}>
          <PendingGuardHarness />
        </StudioRouterProvider>,
      ),
    );

    await act(async () => { void nav('/?session=s2&project=p2#project/p2'); });
    await act(async () => { void nav(-1); await new Promise(resolve => setTimeout(resolve, 0)); });
    // Blocked Back keeps the active URL on p2 while saves flush.
    expect(currentSearch).toBe('?session=s2&project=p2');

    // User navigates to a same-project page before the older save flush settles.
    await act(async () => { void nav('/?session=s2&project=p2&page=mcp#project/p2'); });
    expect(currentSearch).toBe('?session=s2&project=p2&page=mcp');

    await act(async () => { resolveSave(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(currentSearch).toBe('?session=s2&project=p2&page=mcp');
    expect(onProceed).not.toHaveBeenCalled();
  });
});

describe('StudioRouterProvider StrictMode and location.state bridge', () => {
  it('propagates breadcrumb source via location.state and stays alive under StrictMode', async () => {
    let observedHref = '';
    let observedSourceHref: string | null = null;

    function BridgeProbe() {
      const loc = useLocation();
      observedHref = `${loc.pathname}${loc.search}${loc.hash}`;
      observedSourceHref = readLocationWorkspaceSource(loc.state)?.href ?? null;
      return null;
    }

    await act(async () =>
      root.render(
        <StrictMode>
          <StudioRouterProvider memory initialEntries={['/?page=explore']}>
            <BridgeProbe />
          </StudioRouterProvider>
        </StrictMode>,
      ),
    );

    expect(observedHref).toBe('/?page=explore');
    expect(workspaceHistoryIndex()).toBe(0);

    const originHref = `${location.origin}/?page=explore`;
    await act(async () => {
      writeWorkspaceHistory('/?page=mcp', false, {
        page: { href: originHref, index: 0 },
        settings: null,
      });
    });

    expect(observedHref).toBe('/?page=mcp');
    expect(workspaceHistoryIndex()).toBe(1);
    expect(observedSourceHref).toBe(originHref);

    await act(async () => {
      expect(restoreWorkspaceSource({ href: originHref, index: 0 })).toBe(true);
    });
    expect(observedHref).toBe('/?page=explore');
    expect(workspaceHistoryIndex()).toBe(0);
  });
});
