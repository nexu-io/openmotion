// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { initializeWorkspaceHistory, workspaceHistoryIndex, workspaceHistorySession, workspaceHistoryAvailability, traverseWorkspaceHistory, writeWorkspaceHistory } from './workspaceHistory';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

it('retains history identity through editor hash writes and deduplicates the current destination', () => {
  history.replaceState({ integration: 'retained' }, '', '/?page=mcp&project=project#project/project');
  initializeWorkspaceHistory();
  const start = workspaceHistoryIndex();
  writeWorkspaceHistory('#project/project?v=1&t=8', true);
  expect(workspaceHistoryIndex()).toBe(start);
  expect(history.state.integration).toBe('retained');
  expect(location.search).toBe('?page=mcp&project=project');
  const push = vi.spyOn(history, 'pushState');
  writeWorkspaceHistory(location.href);
  expect(push).not.toHaveBeenCalled();
  writeWorkspaceHistory('/?page=settings&section=general&project=project#project/project?t=8');
  expect(workspaceHistoryIndex()).toBe(start! + 1);
  expect(push).toHaveBeenCalledOnce();
});

it('rejects cross-origin navigation before changing history', () => {
  const source = location.href;
  expect(() => writeWorkspaceHistory('https://example.com/')).toThrow('this origin');
  expect(location.href).toBe(source);
});

const traverse = async (delta: -1 | 1) => {
  traverseWorkspaceHistory(delta);
  await new Promise(resolve => setTimeout(resolve, 0));
};

it('bounds navigation to this product visit and discards Forward after a new branch', async () => {
  history.replaceState(null, '', '/previous-site');
  history.pushState(null, '', '/?page=mcp');
  initializeWorkspaceHistory();
  const session = workspaceHistorySession();
  const go = vi.spyOn(history, 'go');
  await traverse(-1); await traverse(1);
  expect(go).not.toHaveBeenCalled();
  expect(workspaceHistoryAvailability()).toBe(0);
  writeWorkspaceHistory('/?page=settings&section=general');
  writeWorkspaceHistory('/?page=settings&section=appearance');
  expect(workspaceHistoryAvailability()).toBe(1);
  await traverse(-1);
  expect(workspaceHistoryAvailability()).toBe(3);
  // A new module instance models a reload; bounds live in tab-scoped storage.
  vi.resetModules();
  const reloaded = await import('./workspaceHistory');
  reloaded.initializeWorkspaceHistory();
  expect(reloaded.workspaceHistoryAvailability()).toBe(3);
  expect(workspaceHistorySession()).toBe(session);
  await traverse(-1);
  expect(workspaceHistoryAvailability()).toBe(2);
  expect(location.pathname).toBe('/');
  writeWorkspaceHistory('/?page=settings&section=help');
  expect(workspaceHistoryAvailability()).toBe(1);
  expect(workspaceHistoryIndex()).toBe(1);
});

it('starts a copied or legacy URL with no product history', () => {
  history.replaceState({ openmotionHistoryIndex: 8, integration: true }, '', '/?page=settings&section=about');
  initializeWorkspaceHistory();
  expect(workspaceHistoryAvailability()).toBe(0);
  expect(workspaceHistoryIndex()).toBe(0);
  expect(history.state.integration).toBe(true);
});

it('keeps Back and Forward usable in memory when tab storage is unavailable', async () => {
  vi.stubGlobal('sessionStorage', { getItem() { throw new Error('Unavailable'); }, setItem() { throw new Error('Unavailable'); } });
  initializeWorkspaceHistory();
  writeWorkspaceHistory('/?page=mcp');
  await traverse(-1);
  expect(workspaceHistoryAvailability()).toBe(2);
  await traverse(1);
  expect(workspaceHistoryAvailability()).toBe(1);
});
