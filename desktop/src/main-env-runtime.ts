import { app, BrowserWindow, clipboard, dialog } from 'electron';
import path from 'node:path';
import {
  DEFAULT_STUDIO_URLS,
  DESKTOP_PRODUCT_NAME,
} from '../../shared/desktop-builtin-rules.ts';
import type { HostPlatform, HostReleaseChannel } from '../../shared/desktop-contract.ts';
import type { DesktopAuthHandoffManager } from './auth-handoff.ts';
import type { CapabilityRegistry } from './capability-registry.ts';
import {
  DEFAULT_LOCAL_DEV_STUDIO_URL,
  describeDesktopEnvironment,
  validateTestEnvironmentUrl,
  type DesktopEnvironmentDescription,
  type DesktopEnvironmentStore,
  type TestEnvironmentValidationOptions,
} from './env-switcher.ts';
import type { DesktopLogger } from './logger.ts';
import { getDesktopWindowBackgroundColor } from './platform.ts';
import type { TaskProgressCoordinator, WakeLockManager } from './ux-controllers.ts';

export type DesktopEnvironmentControllerDeps = {
  distDir: string;
  platform: HostPlatform;
  releaseChannel: HostReleaseChannel;
  envSwitcherEnabled: boolean;
  envValidationOptions: TestEnvironmentValidationOptions;
  envStore: DesktopEnvironmentStore | null;
  authHandoff: DesktopAuthHandoffManager;
  registry: CapabilityRegistry;
  logger: DesktopLogger;
  wakeLockManager: WakeLockManager;
  progressCoordinator: TaskProgressCoordinator;
  getMainWindow: () => BrowserWindow | null;
  createMainWindow: () => BrowserWindow;
  getCurrentTheme: () => 'light' | 'dark';
  getEffectiveAppLocale: () => string;
  isZhAppLocale: () => boolean;
  isShuttingDown: () => boolean;
  getActiveWindowPartition: () => string | undefined;
  setSwitchingMainWindow: (switching: boolean) => void;
  clearCliStudioUrlOverride: () => void;
  setInWindowAuthFallbackActive: (active: boolean) => void;
  resolveBaseDefaultStudioUrl: () => string;
  resolveStudioUrl: () => string;
  resolveStudioOrigin: () => string;
  resolveCurrentEnvironmentDescription: () => DesktopEnvironmentDescription;
  resolveCurrentSessionPartition: () => string | undefined;
  clearStartupLoadWatchdog: () => void;
  clearUnresponsiveTimer: () => void;
  flushMainWindowState: () => void;
  focusOrRestoreMainWindow: () => void;
  refreshDesktopMenus: (force?: boolean) => void;
  loadStudioIntoMainWindow: (targetPath?: string) => Promise<void>;
  showDesktopNotification: (options: {
    title: string;
    body?: string;
    whenUnfocusedOnly?: boolean;
  }) => unknown;
};

export type DesktopEnvironmentController = {
  getSwitcherWindow: () => BrowserWindow | null;
  resolveMainWindowTitle: () => string;
  buildSwitcherPayload: () => {
    channel: HostReleaseChannel;
    defaultOrigin: string;
    active: DesktopEnvironmentDescription;
    presets: Array<{ label: string; url: string; origin: string }>;
    recent: Array<{ label: string; url: string; origin: string }>;
  };
  openSwitcherWindow: () => void;
  closeSwitcherWindow: () => void;
  syncEnvironmentBadge: (win: BrowserWindow) => Promise<void>;
  switchEnvironment: (
    nextUrl: string | null,
    targetPath?: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  clearCurrentDataAndReload: () => Promise<void>;
  copyDiagnostics: () => void;
  handleDeepLinkOpen: (params: Readonly<Record<string, string>>) => Promise<void>;
};

/**
 * Owns test/dev Studio environment switching, isolated session partition swaps,
 * environment switcher modal window, floating env badge, and `env=` deep-link
 * confirmation. Always fail-closed on `stable` releases.
 */
export function createDesktopEnvironmentController(
  deps: DesktopEnvironmentControllerDeps,
): DesktopEnvironmentController {
  let envSwitcherWindow: BrowserWindow | null = null;
  let deepLinkEnvConfirmOpen = false;

  function resolveMainWindowTitle(): string {
    const envDesc = deps.resolveCurrentEnvironmentDescription();
    if (deps.envSwitcherEnabled && envDesc.isCustomOverride && envDesc.badge) {
      return `${DESKTOP_PRODUCT_NAME} · ${envDesc.badge}`;
    }
    return DESKTOP_PRODUCT_NAME;
  }

  function buildSwitcherPayload() {
    const active = deps.resolveCurrentEnvironmentDescription();
    const baseDefaultUrl = deps.resolveBaseDefaultStudioUrl();
    const defaultOrigin = new URL(baseDefaultUrl).origin;
    const presets = [
      {
        label: deps.isZhAppLocale() ? 'Test 默认测试环境' : 'Test Default',
        url: DEFAULT_STUDIO_URLS.test,
        origin: new URL(DEFAULT_STUDIO_URLS.test).origin,
      },
      {
        label: deps.isZhAppLocale() ? '本地开发服务器' : 'Local Dev Server',
        url: DEFAULT_LOCAL_DEV_STUDIO_URL,
        origin: new URL(DEFAULT_LOCAL_DEV_STUDIO_URL).origin,
      },
    ];
    const recent = (deps.envStore?.get().recent ?? []).map(item => {
      const desc = describeDesktopEnvironment(item.url, {
        channel: deps.releaseChannel,
        defaultUrl: baseDefaultUrl,
      });
      return {
        label:
          desc.badge && desc.badge !== desc.label ? `${desc.badge} · ${desc.label}` : desc.label,
        url: desc.url,
        origin: desc.origin,
      };
    });
    return {
      channel: deps.releaseChannel,
      defaultOrigin,
      active,
      presets,
      recent,
    };
  }

  function closeSwitcherWindow(): void {
    const win = envSwitcherWindow;
    envSwitcherWindow = null;
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
  }

  function openSwitcherWindow(): void {
    if (!deps.envSwitcherEnabled || deps.isShuttingDown()) return;
    if (envSwitcherWindow && !envSwitcherWindow.isDestroyed()) {
      envSwitcherWindow.focus();
      return;
    }
    const width = 520;
    const height = 430;
    let x: number | undefined;
    let y: number | undefined;
    const mainWindow = deps.getMainWindow();
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    if (parent) {
      const parentBounds = parent.getBounds();
      x = Math.round(parentBounds.x + (parentBounds.width - width) / 2);
      y = Math.round(parentBounds.y + Math.max(48, (parentBounds.height - height) / 3));
    }
    const currentTheme = deps.getCurrentTheme();
    const switcher = new BrowserWindow({
      width,
      height,
      ...(typeof x === 'number' && typeof y === 'number' ? { x, y } : {}),
      minWidth: 440,
      minHeight: 360,
      resizable: true,
      minimizable: false,
      maximizable: false,
      // Never use macOS modal sheets (`modal: true` + `parent`): sheets hide traffic lights
      // and can deadlock native `dialog.showMessageBox` during Cmd+Q quit confirmation.
      modal: false,
      show: false,
      title: deps.isZhAppLocale() ? '切换测试环境' : 'Switch Environment',
      backgroundColor: getDesktopWindowBackgroundColor(currentTheme),
      ...(deps.platform === 'darwin'
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 15, y: 15 },
            roundedCorners: true,
          }
        : {}),
      webPreferences: {
        preload: path.join(deps.distDir, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    envSwitcherWindow = switcher;
    switcher.setMenuBarVisibility(false);
    switcher.on('closed', () => {
      if (envSwitcherWindow === switcher) {
        envSwitcherWindow = null;
      }
    });
    switcher.once('ready-to-show', () => {
      if (!switcher.isDestroyed()) {
        switcher.show();
        switcher.focus();
      }
    });
    void switcher.loadFile(path.join(deps.distDir, 'env-switcher.html'), {
      query: {
        theme: currentTheme,
        locale: deps.getEffectiveAppLocale(),
        platform: deps.platform,
      },
    });
  }

  async function syncEnvironmentBadge(win: BrowserWindow): Promise<void> {
    if (win.isDestroyed()) return;
    const title = resolveMainWindowTitle();
    try {
      win.setTitle(title);
    } catch {
      // Ignore title update errors during teardown.
    }
    const currentUrl = win.webContents.getURL();
    if (!currentUrl || (!currentUrl.startsWith('https://') && !currentUrl.startsWith('http://'))) {
      return;
    }
    const envDesc = deps.resolveCurrentEnvironmentDescription();
    if (!deps.envSwitcherEnabled || !envDesc.isCustomOverride || !envDesc.badge) {
      void win.webContents
        .executeJavaScript(
          `(() => { const el = document.querySelector('[data-om-desktop-env-badge]'); if (el) el.remove(); })();`,
        )
        .catch(() => {});
      return;
    }
    const labelText = `${envDesc.badge} · ${new URL(envDesc.url).host}`;
    const isDark = deps.getCurrentTheme() === 'dark';
    void win.webContents
      .executeJavaScript(
        `(() => {
          let el = document.querySelector('[data-om-desktop-env-badge]');
          if (!el) {
            el = document.createElement('div');
            el.setAttribute('data-om-desktop-env-badge', 'true');
            Object.assign(el.style, {
              position: 'fixed',
              right: '12px',
              bottom: '12px',
              zIndex: '2147483640',
              pointerEvents: 'none',
              padding: '4px 10px',
              borderRadius: '999px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '11px',
              fontWeight: '600',
              letterSpacing: '0.02em',
              boxShadow: '0 4px 14px rgba(0, 0, 0, 0.22)',
            });
            document.body && document.body.appendChild(el);
          }
          el.style.background = ${JSON.stringify(isDark ? '#202123' : '#ffffff')};
          el.style.color = ${JSON.stringify(isDark ? '#f7f8f5' : '#202020')};
          el.style.border = ${JSON.stringify(isDark ? '1px solid #484b4d' : '1px solid #bdbdbd')};
          el.textContent = ${JSON.stringify(labelText)};
        })();`,
      )
      .catch(() => {});
  }

  async function switchEnvironment(
    nextUrl: string | null,
    targetPath?: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!deps.envSwitcherEnabled || !deps.envStore) {
      return { ok: false, reason: 'Environment switching is disabled in stable releases.' };
    }
    const baseDefaultUrl = deps.resolveBaseDefaultStudioUrl();
    const baseDefaultOrigin = new URL(baseDefaultUrl).origin;
    let effectiveOverride: string | null = nextUrl;
    if (effectiveOverride !== null) {
      const checked = validateTestEnvironmentUrl(effectiveOverride, deps.envValidationOptions);
      if (!checked.ok) {
        return checked;
      }
      effectiveOverride = checked.origin === baseDefaultOrigin ? null : checked.normalizedUrl;
    }

    deps.clearCliStudioUrlOverride();
    const saved = deps.envStore.setOverride(effectiveOverride);
    if (!saved.ok) {
      return saved;
    }

    deps.authHandoff.cancelLogin();
    deps.setInWindowAuthFallbackActive(false);
    deps.clearStartupLoadWatchdog();
    deps.clearUnresponsiveTimer();
    deps.wakeLockManager.releasePrefix('task:');
    deps.progressCoordinator.clearTasks();

    const nextPartition = deps.resolveCurrentSessionPartition();
    deps.logger.info('main', 'Switched desktop test environment', {
      url: deps.resolveStudioUrl(),
      partition: nextPartition ?? 'default',
    });

    const mainWindow = deps.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && nextPartition !== deps.getActiveWindowPartition()) {
      deps.flushMainWindowState();
      const oldWin = mainWindow;
      deps.setSwitchingMainWindow(true);
      try {
        const nextWin = deps.createMainWindow();
        if (!oldWin.isDestroyed()) {
          oldWin.destroy();
        }
        if (!nextWin.isDestroyed()) {
          nextWin.focus();
        }
      } finally {
        deps.setSwitchingMainWindow(false);
      }
    } else if (!mainWindow || mainWindow.isDestroyed()) {
      deps.createMainWindow();
    }

    deps.refreshDesktopMenus(true);
    await deps.loadStudioIntoMainWindow(targetPath);
    return { ok: true };
  }

  async function clearCurrentDataAndReload(): Promise<void> {
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    try {
      await win.webContents.session.clearStorageData();
      await win.webContents.session.clearCache();
    } catch (error) {
      deps.logger.warn('main', 'Failed to clear environment storage/cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await deps.loadStudioIntoMainWindow();
  }

  function copyDiagnostics(): void {
    const envDesc = deps.resolveCurrentEnvironmentDescription();
    const lines = [
      `App: ${DESKTOP_PRODUCT_NAME} v${app.getVersion()} (${deps.releaseChannel}, packaged=${app.isPackaged})`,
      `Platform: ${deps.platform}/${process.arch} (Electron ${process.versions.electron ?? 'unknown'})`,
      `Environment: ${envDesc.label} [${envDesc.badge || deps.releaseChannel}]`,
      `Studio URL: ${envDesc.url}`,
      `Session Partition: ${deps.getActiveWindowPartition() ?? 'default'}`,
      `Capabilities: ${deps.registry
        .listCapabilities()
        .map(cap => `${cap.name}@${cap.version}(${cap.status})`)
        .join(', ')}`,
    ];
    clipboard.writeText(lines.join('\n'));
    const zh = deps.isZhAppLocale();
    deps.showDesktopNotification({
      title: zh ? '已复制环境诊断信息' : 'Environment Info Copied',
      body: `${envDesc.label} · v${app.getVersion()}`,
      whenUnfocusedOnly: false,
    });
  }

  async function handleDeepLinkOpen(params: Readonly<Record<string, string>>): Promise<void> {
    deps.focusOrRestoreMainWindow();
    const requestedEnv = params.env;
    const requestedPath = params.path;

    if (deps.envSwitcherEnabled && requestedEnv) {
      const checked = validateTestEnvironmentUrl(requestedEnv, deps.envValidationOptions);
      if (checked.ok && checked.origin !== deps.resolveStudioOrigin()) {
        if (deepLinkEnvConfirmOpen) return;
        deepLinkEnvConfirmOpen = true;
        try {
          const zh = deps.isZhAppLocale();
          const targetHost = new URL(checked.origin).host;
          const mainWindow = deps.getMainWindow();
          const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
          const dialogOptions = {
            type: 'question' as const,
            title: zh ? '切换测试环境' : 'Switch Test Environment',
            message: zh
              ? `是否将 OpenDesign 切换到 ${targetHost}？`
              : `Switch OpenDesign to ${targetHost}?`,
            detail: zh
              ? `目标地址：${checked.origin}\n每个测试环境都会使用独立隔离的登录态与缓存。`
              : `Target URL: ${checked.origin}\nEach test environment uses an isolated session and cache.`,
            buttons: zh ? ['取消', '切换并打开'] : ['Cancel', 'Switch & Open'],
            defaultId: 1,
            cancelId: 0,
            noLink: true,
          };
          const { response } = parent
            ? await dialog.showMessageBox(parent, dialogOptions)
            : await dialog.showMessageBox(dialogOptions);
          if (response !== 1) return;
        } finally {
          deepLinkEnvConfirmOpen = false;
        }
        await switchEnvironment(checked.normalizedUrl, requestedPath);
        return;
      }
    }

    const mainWindow = deps.getMainWindow();
    if (requestedPath && mainWindow && !mainWindow.isDestroyed()) {
      await deps.loadStudioIntoMainWindow(requestedPath);
    }
  }

  return {
    getSwitcherWindow: () => envSwitcherWindow,
    resolveMainWindowTitle,
    buildSwitcherPayload,
    openSwitcherWindow,
    closeSwitcherWindow,
    syncEnvironmentBadge,
    switchEnvironment,
    clearCurrentDataAndReload,
    copyDiagnostics,
    handleDeepLinkOpen,
  };
}
