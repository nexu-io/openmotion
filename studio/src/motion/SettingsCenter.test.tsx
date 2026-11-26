// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import readme from '../../../README.md?raw';
import chineseReadme from '../../../README.zh-CN.md?raw';
import {
  HOST_CAPABILITIES,
  hostOk,
  type DesktopPreferencesSnapshot,
  type UniversalHostBridge,
} from '../../../shared/desktop-contract';
import { I18nProvider } from '../i18n/I18n';
import { invalidateHostCapabilities } from '../utils/platformHost';
import { SettingsCenter } from './SettingsCenter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  delete window.__OPENMOTION_HOST__;
  vi.restoreAllMocks();
});

function createSnapshot(
  overrides: Partial<DesktopPreferencesSnapshot['values']> = {},
  pendingRestartKeys: DesktopPreferencesSnapshot['pendingRestartKeys'] = [],
): DesktopPreferencesSnapshot {
  return {
    values: {
      confirmBeforeQuit: true,
      openAtLogin: false,
      autoCheckUpdates: true,
      hardwareAcceleration: true,
      locale: 'en',
      lastDownloadDir: null,
      ...overrides,
    },
    descriptors: [
      { key: 'confirmBeforeQuit', supported: true },
      { key: 'openAtLogin', supported: true },
      { key: 'autoCheckUpdates', supported: true },
      { key: 'hardwareAcceleration', supported: true, requiresRestart: true },
      { key: 'locale', supported: true },
      { key: 'lastDownloadDir', supported: true, picker: true },
    ],
    platform: 'darwin',
    pendingRestartKeys,
  };
}

it.each([
  { locale: 'zh-CN', heading: '社群', labels: ['飞书群', 'Discord'], document: chineseReadme, platforms: ['飞书群', 'Discord'] },
  { locale: 'en', heading: 'Community', labels: ['Discord', 'Feishu group'], document: readme, platforms: ['Discord', 'Feishu'] },
] as const)('offers both README invitations in locale order from Help in $locale', ({ locale, heading, labels, document, platforms }) => {
  const html = renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <SettingsCenter section="help" onSection={() => {}} openConnections={() => {}} />
    </I18nProvider>,
  );
  const page = new DOMParser().parseFromString(html, 'text/html');
  const section = page.querySelector('section[aria-labelledby="om-community-heading"]');
  expect(section?.querySelector('h2')?.textContent).toBe(heading);
  const links = Array.from(section!.querySelectorAll('a'));
  expect(links.map(link => link.textContent)).toEqual(labels);
  for (const [index, link] of links.entries()) {
    expect(document).toContain(`[${platforms[index]}](${link.href})`);
    expect(link.target).toBe('_blank');
    expect(link.relList.contains('noopener')).toBe(true);
  }
});

it('hides desktop-only preferences on Web and on older desktop shells lacking the preferences capability', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(
      <I18nProvider initialLocale="en">
        <SettingsCenter section="general" onSection={() => {}} openConnections={() => {}} />
      </I18nProvider>,
    );
  });
  expect(container.querySelector('[data-desktop-preferences="true"]')).toBeNull();

  // Older desktop shell without `preferences` capability also hides desktop-only controls cleanly.
  const olderBridge: UniversalHostBridge = {
    info: vi.fn(async () => ({
      hostKind: 'desktop' as const,
      shellVersion: '0.1.0',
      contractVersion: '1.0.0',
      platform: 'darwin' as const,
      arch: 'arm64',
      releaseChannel: 'stable' as const,
      isPackaged: true,
    })),
    capabilities: vi.fn(async () => [
      { name: HOST_CAPABILITIES.WINDOW, version: '1.0.0', status: 'available' as const },
    ]),
    invoke: vi.fn(async () => hostOk({})),
    subscribe: vi.fn(() => () => {}),
  };
  window.__OPENMOTION_HOST__ = olderBridge;
  invalidateHostCapabilities(olderBridge);

  act(() => root!.unmount());
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider initialLocale="en">
        <SettingsCenter section="general" onSection={() => {}} openConnections={() => {}} />
      </I18nProvider>,
    );
  });
  expect(container.querySelector('[data-desktop-preferences="true"]')).toBeNull();
});

it('renders desktop-only preferences when supported, updates host, handles restart-required, and syncs host events', async () => {
  let currentSnapshot = createSnapshot();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const invoke = vi.fn(async (capability: string, method: string, params?: Record<string, unknown>) => {
    if (capability === HOST_CAPABILITIES.PREFERENCES && method === 'getAll') {
      return hostOk(currentSnapshot);
    }
    if (capability === HOST_CAPABILITIES.PREFERENCES && method === 'set') {
      const key = params?.key as keyof DesktopPreferencesSnapshot['values'];
      const value = params?.value;
      const pending: DesktopPreferencesSnapshot['pendingRestartKeys'] =
        key === 'hardwareAcceleration' && value === false ? ['hardwareAcceleration'] : [];
      currentSnapshot = createSnapshot({ ...currentSnapshot.values, [key]: value }, pending);
      return hostOk({
        key,
        value,
        applied: key === 'hardwareAcceleration' ? 'restart-required' : 'immediate',
        snapshot: currentSnapshot,
      });
    }
    if (capability === HOST_CAPABILITIES.PREFERENCES && method === 'pickDownloadDir') {
      currentSnapshot = createSnapshot({ ...currentSnapshot.values, lastDownloadDir: '/opt/demo/Exports' });
      return hostOk({ canceled: false, path: '/opt/demo/Exports', snapshot: currentSnapshot });
    }
    if (capability === HOST_CAPABILITIES.PREFERENCES && method === 'relaunch') {
      return hostOk({ relaunching: true });
    }
    return hostOk({});
  });

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
      { name: HOST_CAPABILITIES.WINDOW, version: '1.0.0', status: 'available' as const },
      { name: HOST_CAPABILITIES.PREFERENCES, version: '1.0.0', status: 'available' as const },
    ]),
    invoke: invoke as UniversalHostBridge['invoke'],
    subscribe: vi.fn((capability, event, cb) => {
      const key = `${capability}:${event}`;
      const set = listeners.get(key) ?? new Set();
      set.add(cb);
      listeners.set(key, set);
      return () => set.delete(cb);
    }),
  };
  window.__OPENMOTION_HOST__ = bridge;
  invalidateHostCapabilities(bridge);

  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider initialLocale="en">
        <SettingsCenter section="general" onSection={() => {}} openConnections={() => {}} />
      </I18nProvider>,
    );
  });

  const section = container.querySelector('[data-desktop-preferences="true"]');
  expect(section).not.toBeNull();

  // Locale synced to host on mount.
  expect(invoke).toHaveBeenCalledWith(HOST_CAPABILITIES.PREFERENCES, 'set', { key: 'locale', value: 'en' });

  // Toggle hardware acceleration -> shows "Restart to apply" and triggers relaunch.
  const hwToggle = section!.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Hardware acceleration"]')!;
  expect(hwToggle.getAttribute('aria-checked')).toBe('true');
  await act(async () => hwToggle.click());
  expect(invoke).toHaveBeenCalledWith(HOST_CAPABILITIES.PREFERENCES, 'set', {
    key: 'hardwareAcceleration',
    value: false,
  });
  const restartBtn = Array.from(section!.querySelectorAll('button')).find(
    button => button.textContent?.trim() === 'Restart to apply',
  );
  expect(restartBtn).toBeTruthy();
  await act(async () => restartBtn!.click());
  expect(invoke).toHaveBeenCalledWith(HOST_CAPABILITIES.PREFERENCES, 'relaunch');

  // Pick download folder via native host dialog.
  const pickBtn = Array.from(section!.querySelectorAll('button')).find(
    button => button.textContent?.trim() === 'Choose folder',
  )!;
  await act(async () => pickBtn.click());
  expect(invoke).toHaveBeenCalledWith(HOST_CAPABILITIES.PREFERENCES, 'pickDownloadDir');
  expect(section!.textContent).toContain('/opt/demo/Exports');

  // External host event (e.g. toggled in macOS native menu) updates switch live.
  const confirmToggle = section!.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Confirm before quitting"]')!;
  expect(confirmToggle.getAttribute('aria-checked')).toBe('true');
  await act(async () => {
    for (const cb of listeners.get(`${HOST_CAPABILITIES.PREFERENCES}:changed`) ?? []) {
      cb(createSnapshot({ confirmBeforeQuit: false }));
    }
  });
  expect(confirmToggle.getAttribute('aria-checked')).toBe('false');
});
