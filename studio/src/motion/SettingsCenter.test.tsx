// @vitest-environment happy-dom
import { act } from 'react';
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
import { setCloudFeatureOverridesForTest } from '../utils/cloudFeatures';
import { setCachedCloudDisklessMode } from '../utils/cloudRuntime';
import { invalidateHostCapabilities } from '../utils/platformHost';
import { SettingsCenter } from './SettingsCenter';
import { resetAccountSummaryCacheForTest } from './AccountSettings';
import { subscribeEntitlementModal } from './entitlementModalBus';
import { RecoveryScreen } from '../components/RecoveryScreen';
import { setCachedCloudDisklessMode } from '../utils/cloudRuntime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  delete window.__OPENMOTION_HOST__;
  setCloudFeatureOverridesForTest(null);
  setCachedCloudDisklessMode(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  { cloud: true, desktop: false, visible: false },
  { cloud: true, desktop: true, visible: true },
  { cloud: false, desktop: false, visible: true },
])('only offers diagnostic ZIPs on supported hosts (cloud=$cloud, desktop=$desktop)', ({ cloud, desktop, visible }) => {
  setCachedCloudDisklessMode(cloud);
  if (desktop) window.__OPENMOTION_HOST__ = { info: vi.fn(), capabilities: vi.fn(), invoke: vi.fn(), subscribe: vi.fn() };
  try {
    const html = renderToStaticMarkup(<I18nProvider initialLocale="en">
      <RecoveryScreen title="Could not open project" message="Session expired"><button>Retry</button></RecoveryScreen>
      <SettingsCenter section="help" onSection={() => {}} openConnections={() => {}} />
      <SettingsCenter section="privacy" onSection={() => {}} openConnections={() => {}} />
    </I18nProvider>);
    const page = new DOMParser().parseFromString(html, 'text/html');
    const exports = [...page.querySelectorAll('button')].filter(button => button.textContent === 'Export diagnostic ZIP');
    expect(exports).toHaveLength(visible ? 3 : 0);
    expect(Boolean(page.querySelector('.om-recovery-diagnostics'))).toBe(visible);
    expect(page.body.textContent?.includes('Diagnostics & logs')).toBe(visible);
    expect(page.body.textContent).toContain('Share usage data');
    expect(page.body.textContent).toContain('Retry');
  } finally {
    setCachedCloudDisklessMode(null);
  }
});

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

it('guides users to check account & plan in Default models when no media models are available', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('models/catalog')) {
      return Response.json({ provider: 'opendesign', mode: 'opendesign', defaults: {}, models: [] });
    }
    return Response.json({
      providers: [{ id: 'opendesign', label: 'OpenDesign', configured: true, enabled: true, available: false }],
      routes: {},
    });
  }));
  const onSection = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <I18nProvider initialLocale="zh-CN">
      <SettingsCenter section="models" onSection={onSection} openConnections={() => {}} />
    </I18nProvider>,
  ));
  const emptyGuide = host.querySelector('[data-empty-models="true"]');
  expect(emptyGuide).not.toBeNull();
  expect(emptyGuide?.textContent).toContain('当前暂无可用媒体模型');
  expect(host.textContent).toContain('暂无可用模型');
  const accountBtn = [...emptyGuide!.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.trim() === '查看账户与订阅方案')!;
  expect(accountBtn).toBeTruthy();
  await act(async () => accountBtn.click());
  expect(onSection).toHaveBeenCalledWith('subscription');
});

it('hides the Model providers entry and internal gateway jumps in Cloud P1 mode, while restoring them when re-enabled', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('models/catalog')) {
      return Response.json({ provider: 'opendesign', mode: 'opendesign', defaults: {}, models: [] });
    }
    if (String(url).includes('account/summary')) {
      return Response.json({ authenticated: true, authMode: 'oidc', user: { id: 'u1', email: 'ada@example.test', displayName: 'Ada' } });
    }
    return Response.json({
      providers: [{ id: 'opendesign', label: 'OpenDesign', configured: true, enabled: true, available: false }],
      routes: {},
      tokens: [],
      connections: [],
    });
  }));
  setCachedCloudDisklessMode(true);
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);

  await act(async () => root!.render(
    <I18nProvider initialLocale="zh-CN">
      <SettingsCenter section="providers" onSection={() => {}} openConnections={() => {}} />
    </I18nProvider>,
  ));

  const navLabels = [...host.querySelectorAll('.om-settings-sections button')].map(btn => btn.textContent?.trim());
  expect(navLabels).not.toContain('模型供应商');
  expect(navLabels).toContain('默认模型');
  expect(host.querySelector('.om-settings-main h1')?.textContent).toBe('默认模型');
  const defaultModelsButtons = [...host.querySelectorAll('.om-settings-main button')].map(btn => btn.textContent?.trim());
  expect(defaultModelsButtons).toContain('查看账户与订阅方案');
  expect(defaultModelsButtons).not.toContain('模型网关');

  await act(async () => root!.render(
    <I18nProvider initialLocale="zh-CN">
      <SettingsCenter section="account" onSection={() => {}} openConnections={() => {}} />
    </I18nProvider>,
  ));
  const accountButtons = [...host.querySelectorAll('.om-settings-main button')].map(btn => btn.textContent?.trim());
  expect(accountButtons).not.toContain('模型网关');

  setCloudFeatureOverridesForTest({ modelProviders: true });
  await act(async () => root!.render(
    <I18nProvider initialLocale="zh-CN">
      <SettingsCenter section="account" onSection={() => {}} openConnections={() => {}} />
    </I18nProvider>,
  ));
  const restoredNavLabels = [...host.querySelectorAll('.om-settings-sections button')].map(btn => btn.textContent?.trim());
  expect(restoredNavLabels).toContain('模型供应商');
  const restoredAccountButtons = [...host.querySelectorAll('.om-settings-main button')].map(btn => btn.textContent?.trim());
  expect(restoredAccountButtons).toContain('模型网关');
});

const unauthorized = () => Response.json(
  { code: 'UNAUTHORIZED', errorCode: 'auth_required', sessionExpired: false, error: 'Authentication required' },
  { status: 401 },
);
const previewModel = { id: 'opendesign:gpt-image-2.6-flare', provider: 'opendesign', modelId: 'gpt-image-2.6-flare', label: 'GPT Image 2.6 Flare', modality: 'image', source: 'builtin' };
const unavailableStatus = () => Response.json({
  providers: [{ id: 'opendesign', label: 'OpenDesign', configured: true, enabled: true, available: false, credentialSource: 'environment' }],
  routes: {},
});

it.each([
  { name: 'empty public catalog', catalog: () => Response.json({ provider: 'opendesign', mode: 'opendesign', defaults: {}, models: [] }) },
  { name: 'public preview catalog', catalog: () => Response.json({ provider: 'opendesign', mode: 'opendesign', defaults: {}, models: [previewModel] }) },
  { name: 'catalog requiring auth', catalog: unauthorized },
])('asks signed-out visitors to sign in on Default models instead of offering a Plus upgrade ($name)', async ({ catalog }) => {
  resetAccountSummaryCacheForTest();
  setCachedCloudDisklessMode(true);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('models/catalog')) return catalog();
    if (String(url).includes('models/status')) return unavailableStatus();
    return unauthorized();
  }));
  const modal = vi.fn();
  const unsubscribe = subscribeEntitlementModal(modal);
  const onSection = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  try {
    await act(async () => root!.render(
      <I18nProvider initialLocale="zh-CN">
        <SettingsCenter section="models" onSection={onSection} openConnections={() => {}} />
      </I18nProvider>,
    ));
    const main = host.querySelector('.om-settings-main')!;
    expect(main.querySelector('h1')?.textContent).toBe('默认模型');
    expect(main.querySelector('[data-empty-models="true"]')).toBeNull();
    expect(main.textContent).not.toContain('Plus');
    expect(main.querySelector('button[aria-label="选择模型"]')).toBeNull();
    const guide = main.querySelector('[data-guest-auth-guide="true"]');
    expect(guide).not.toBeNull();
    const signIn = [...guide!.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.trim() === '使用 OpenDesign 登录');
    expect(signIn).toBeTruthy();
    await act(async () => signIn!.click());
    expect(modal).toHaveBeenCalledWith({ mode: 'guest', hookId: 'settings_signin' });
    expect(onSection).not.toHaveBeenCalledWith('subscription');
  } finally {
    unsubscribe();
    resetAccountSummaryCacheForTest();
  }
});

it.each([
  { name: 'no models', models: [], emptyGuide: true },
  { name: 'available models', models: [previewModel], emptyGuide: false },
])('keeps the signed-in Default models view unchanged with $name', async ({ models, emptyGuide }) => {
  resetAccountSummaryCacheForTest();
  setCachedCloudDisklessMode(true);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('models/catalog')) return Response.json({ provider: 'opendesign', mode: 'opendesign', defaults: {}, models });
    if (String(url).includes('account/summary')) {
      return Response.json({ authenticated: true, authMode: 'oidc', user: { id: 'u1', email: 'ada@example.test', displayName: 'Ada' }, billing: { plan: 'plus' } });
    }
    return Response.json({
      providers: [{ id: 'opendesign', label: 'OpenDesign', configured: true, enabled: true, available: models.length > 0, credentialSource: 'environment' }],
      routes: {},
    });
  }));
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  try {
    await act(async () => root!.render(
      <I18nProvider initialLocale="zh-CN">
        <SettingsCenter section="models" onSection={() => {}} openConnections={() => {}} />
      </I18nProvider>,
    ));
    const main = host.querySelector('.om-settings-main')!;
    expect(main.querySelector('[data-guest-auth-guide="true"]')).toBeNull();
    expect(Boolean(main.querySelector('[data-empty-models="true"]'))).toBe(emptyGuide);
    expect(main.querySelectorAll('button[aria-label="选择模型"]')).toHaveLength(3);
  } finally {
    resetAccountSummaryCacheForTest();
  }
});
