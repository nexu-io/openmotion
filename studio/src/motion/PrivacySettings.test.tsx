// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider, useI18n, translate } from '../i18n/I18n';
import { PrivacySettings } from './PrivacySettings';
import { HOST_CAPABILITIES, hostOk, type UniversalHostBridge } from '../../../shared/desktop-contract';
import { invalidateHostCapabilities } from '../utils/platformHost';

const hooks = vi.hoisted(() => ({ enabled: vi.fn() }));
vi.mock('./tracking', () => ({ setMotionTrackingEnabled: hooks.enabled }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; delete window.__OPENMOTION_HOST__; vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function open() {
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<I18nProvider initialLocale="en"><PrivacySettings onClose={() => {}} /></I18nProvider>));
  return container.querySelector<HTMLButtonElement>('[role=switch]')!;
}

it('shows the enabled default and persists a user opt-out while stopping browser collection', async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    requests.push(init ?? {});
    const enabled = init?.body ? JSON.parse(String(init.body)).enabled : true;
    return Response.json({ enabled, preference: enabled, locked: false });
  }));
  const toggle = await open(); expect((toggle.getAttribute('aria-checked') === 'true')).toBe(true); expect(toggle.disabled).toBe(false);
  await act(async () => toggle.click());
  expect((toggle.getAttribute('aria-checked') === 'true')).toBe(false);
  expect(requests[1].method).toBe('PUT'); expect(JSON.parse(String(requests[1].body))).toEqual({ enabled: false });
  expect(hooks.enabled).toHaveBeenCalledWith(false);
  for (let cycle = 0; cycle < 2; cycle++) {
    await act(async () => toggle.click()); expect((toggle.getAttribute('aria-checked') === 'true')).toBe(true);
    expect(hooks.enabled).toHaveBeenLastCalledWith(true);
    await act(async () => toggle.click()); expect((toggle.getAttribute('aria-checked') === 'true')).toBe(false);
    expect(hooks.enabled).toHaveBeenLastCalledWith(false);
  }
});

it('locks collection in test builds without overwriting the saved production preference', async () => {
  const fetcher = vi.fn(async () => Response.json({ enabled: false, preference: true, locked: true, reason: 'test_build' }));
  vi.stubGlobal('fetch', fetcher);
  const toggle = await open(); expect((toggle.getAttribute('aria-checked') === 'true')).toBe(false); expect(toggle.disabled).toBe(true);
  await act(async () => toggle.click());
  expect(fetcher).toHaveBeenCalledTimes(1); expect(hooks.enabled).not.toHaveBeenCalled();
  expect(document.querySelector('[role=status]')?.textContent).toContain('disabled in test builds');
});

it('shows an environment lock and never offers to override it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: false, preference: true, locked: true })));
  const toggle = await open(); expect((toggle.getAttribute('aria-checked') === 'true')).toBe(false); expect(toggle.disabled).toBe(true);
  expect(document.body.textContent).toContain('Disabled by your environment settings.');
});

it('shows a deployment lock message when cloud tracking is enabled and managed by deployment', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: true, preference: true, locked: true, reason: 'deployment' })));
  const toggle = await open(); expect((toggle.getAttribute('aria-checked') === 'true')).toBe(true); expect(toggle.disabled).toBe(true);
  expect(document.body.textContent).toContain('Managed by your deployment settings.');
});

it('reports save failure without falsely claiming the installation has opted out', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT'
    ? Response.json({ error: 'failed' }, { status: 500 }) : Response.json({ enabled: true, preference: true, locked: false })));
  const toggle = await open(); await act(async () => toggle.click());
  expect((toggle.getAttribute('aria-checked') === 'true')).toBe(true); expect(document.querySelector('[role=alert]')?.textContent).toContain('Changes could not be saved.');
  expect(hooks.enabled).toHaveBeenCalledWith(false);
});

it('translates an existing failure without refetching or replacing the privacy form', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT'
    ? Response.json({ error: 'failed' }, { status: 500 }) : Response.json({ enabled: true, preference: true, locked: false }));
  vi.stubGlobal('fetch', fetcher);
  function App() {
    const { setLocale } = useI18n();
    return <><button onClick={() => setLocale('ja')}>Japanese</button><PrivacySettings onClose={() => {}} /></>;
  }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<I18nProvider initialLocale="en"><App /></I18nProvider>));
  const toggle = container.querySelector<HTMLButtonElement>('[role=switch]')!;
  await act(async () => toggle.click());
  expect(document.querySelector('[role=alert]')?.textContent).toBe('Changes could not be saved.');
  await act(async () => container.querySelector('button')!.click());
  expect(document.querySelector('[role=alert]')?.textContent).toBe(translate('ja', 'Changes could not be saved.'));
  expect(container.querySelector('[role=switch]')).toBe(toggle);
  expect((toggle.getAttribute('aria-checked') === 'true')).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('syncs usage-data preference changes to desktop host telemetry capability when available', async () => {
  const invoke = vi.fn(async () => hostOk({ enabled: false }));
  const bridge: UniversalHostBridge = {
    info: vi.fn(async () => ({
      hostKind: 'desktop' as const,
      shellVersion: '0.2.1',
      contractVersion: '1.0.0',
      platform: 'darwin' as const,
      arch: 'arm64',
      releaseChannel: 'test' as const,
      isPackaged: true,
    })),
    capabilities: vi.fn(async () => [
      { name: HOST_CAPABILITIES.TELEMETRY, version: '1.0.0', status: 'available' as const },
    ]),
    invoke: invoke as UniversalHostBridge['invoke'],
    subscribe: vi.fn(() => () => {}),
  };
  window.__OPENMOTION_HOST__ = bridge;
  invalidateHostCapabilities(bridge);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const enabled = init?.body ? JSON.parse(String(init.body)).enabled : true;
    return Response.json({ enabled, preference: enabled, locked: false });
  }));

  const toggle = await open();
  expect(invoke).toHaveBeenCalledWith(HOST_CAPABILITIES.TELEMETRY, 'setEnabled', { enabled: true });
  await act(async () => toggle.click());
  expect(invoke).toHaveBeenCalledWith(HOST_CAPABILITIES.TELEMETRY, 'setEnabled', { enabled: false });
});
