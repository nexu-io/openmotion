// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllSwrCache,
  clearPrivateSwrCache,
  readSwrCache,
  setPrivateSwrIdentity,
  setSwrCacheEnabledForTests,
  writeSwrCache,
} from './swrCache';

describe('swrCache', () => {
  beforeEach(() => {
    setSwrCacheEnabledForTests(true);
    clearAllSwrCache();
    localStorage.clear();
  });

  afterEach(() => {
    clearAllSwrCache();
    localStorage.clear();
    setSwrCacheEnabledForTests(null);
    vi.useRealTimers();
  });

  it('persists public and private snapshots across reloads and isolates scopes by account/workspace', () => {
    // Private reads/writes require a verified identity.
    writeSwrCache('private', 'workspace-catalog', { activeId: 'anon', projects: [] });
    expect(readSwrCache('private', 'workspace-catalog')).toBeNull();

    setPrivateSwrIdentity({ userId: 'user-a', workspaceId: 'ws-1' });
    writeSwrCache('public', 'template-catalog:en:1', { items: [{ id: 't1' }], catalogVersion: 'v1' });
    writeSwrCache('private', 'workspace-catalog', { activeId: 'p1', projects: [{ id: 'p1', title: 'Demo' }] });

    expect(readSwrCache('public', 'template-catalog:en:1')).toEqual({
      items: [{ id: 't1' }],
      catalogVersion: 'v1',
    });
    expect(readSwrCache('private', 'workspace-catalog')).toEqual({
      activeId: 'p1',
      projects: [{ id: 'p1', title: 'Demo' }],
    });

    // Switching workspace immediately clears the previous workspace's private snapshot while keeping public cache.
    expect(setPrivateSwrIdentity({ userId: 'user-a', workspaceId: 'ws-2' })).toBe(true);
    expect(readSwrCache('private', 'workspace-catalog')).toBeNull();
    expect(readSwrCache('public', 'template-catalog:en:1')).toEqual({
      items: [{ id: 't1' }],
      catalogVersion: 'v1',
    });

    writeSwrCache('private', 'workspace-catalog', { activeId: 'p2', projects: [{ id: 'p2', title: 'WS2' }] });
    // Switching account also purges previous private snapshots.
    expect(setPrivateSwrIdentity({ userId: 'user-b', workspaceId: 'ws-2' })).toBe(true);
    expect(readSwrCache('private', 'workspace-catalog')).toBeNull();

    // Clearing private cache (e.g. on sign-out / 401) preserves public catalog snapshots.
    writeSwrCache('private', 'workspace-catalog', { activeId: 'p3', projects: [] });
    clearPrivateSwrCache();
    expect(readSwrCache('private', 'workspace-catalog')).toBeNull();
    expect(readSwrCache('public', 'template-catalog:en:1')).toEqual({
      items: [{ id: 't1' }],
      catalogVersion: 'v1',
    });
  });

  it('expires stale snapshots once TTL elapses and recovers from corrupt storage entries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T00:00:00Z'));

    writeSwrCache('public', 'short-lived', { ok: true }, 5_000);
    expect(readSwrCache('public', 'short-lived')).toEqual({ ok: true });

    vi.advanceTimersByTime(6_000);
    expect(readSwrCache('public', 'short-lived')).toBeNull();

    localStorage.setItem('om:swr:v1:public:corrupt', '{bad-json');
    expect(readSwrCache('public', 'corrupt')).toBeNull();
    expect(localStorage.getItem('om:swr:v1:public:corrupt')).toBeNull();
  });
});
