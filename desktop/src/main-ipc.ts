import { type BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import {
  HOST_CAPABILITIES,
  hostErr,
  hostOk,
  type HostReleaseChannel,
  type HostRuntimeInfo,
} from '../../shared/desktop-contract.ts';
import type { DesktopDiagnosticExportResult } from '../../shared/platform-host.ts';
import type { DesktopAuthHandoffManager } from './auth-handoff.ts';
import type { CapabilityRegistry } from './capability-registry.ts';
import {
  authorizeEnvSwitcherSender,
  authorizePrivilegedIpcSender,
  authorizeSplashSender,
  HOST_IPC_CHANNELS,
  type PrivilegedIpcGuardOptions,
  type SplashAllowedAction,
} from './ipc-guard.ts';
import type { DesktopEnvironmentController } from './main-env-runtime.ts';
import type { DesktopUpdaterController } from './updater.ts';

export type RegisterDesktopIpcDeps = {
  distDir: string;
  releaseChannel: HostReleaseChannel;
  envSwitcherEnabled: boolean;
  registry: CapabilityRegistry;
  updater: DesktopUpdaterController;
  authHandoff: DesktopAuthHandoffManager;
  envController: DesktopEnvironmentController;
  getMainWindow: () => BrowserWindow | null;
  getPrivilegedGuardOptions: () => PrivilegedIpcGuardOptions;
  /** Called when a page holding the bridge is refused; the caller decides what to report. */
  onPrivilegedIpcDenied?: (error: { code: string; message: string }) => void;
  buildRuntimeInfo: () => HostRuntimeInfo;
  resolveStudioUrl: () => string;
  loadStudioIntoMainWindow: (targetPath?: string) => Promise<void>;
  exportLogsWithDialog: () => Promise<DesktopDiagnosticExportResult>;
  setDomFullscreen: (active: boolean) => void;
  broadcastChromeState: () => void;
  refreshDesktopMenus: (force?: boolean) => void;
  isManualUpdateCheckPending: () => boolean;
  setManualUpdateCheckPending: (pending: boolean) => void;
  maybePresentManualUpdateFeedback: (
    state: ReturnType<DesktopUpdaterController['getState']>,
  ) => Promise<void>;
  getLastNotifiedDownloadedVersion: () => string | null;
  setLastNotifiedDownloadedVersion: (version: string | null) => void;
  isZhAppLocale: () => boolean;
  focusOrRestoreMainWindow: () => void;
  showDesktopNotification: (options: {
    title: string;
    body?: string;
    whenUnfocusedOnly?: boolean;
    onClick?: () => void;
  }) => unknown;
};

/**
 * Registers all main-process Electron IPC handlers (privileged universal bridge,
 * splash/retry recovery actions, test-only environment switcher modal, and DOM
 * fullscreen sync) and attaches updater/auth event bridges.
 */
export function registerDesktopIpc(deps: RegisterDesktopIpcDeps): void {
  const allowedSplashFiles = [
    path.join(deps.distDir, 'splash.html'),
    path.join(deps.distDir, 'retry.html'),
  ];
  const allowedEnvSwitcherFiles = [path.join(deps.distDir, 'env-switcher.html')];

  function authorizeSplashOrMain(
    event: Electron.IpcMainInvokeEvent,
    action: SplashAllowedAction,
  ) {
    return authorizeSplashSender(event, action, {
      splashWindow: deps.getMainWindow(),
      allowedFilePaths: allowedSplashFiles,
    });
  }

  ipcMain.handle(HOST_IPC_CHANNELS.INFO, event => {
    const auth = authorizePrivilegedIpcSender(event, deps.getPrivilegedGuardOptions());
    if (!auth.ok) {
      deps.onPrivilegedIpcDenied?.(auth.error);
      throw new Error(auth.error.message);
    }
    return deps.buildRuntimeInfo();
  });

  ipcMain.handle(HOST_IPC_CHANNELS.CAPABILITIES, event => {
    const auth = authorizePrivilegedIpcSender(event, deps.getPrivilegedGuardOptions());
    if (!auth.ok) {
      deps.onPrivilegedIpcDenied?.(auth.error);
      throw new Error(auth.error.message);
    }
    return deps.registry.listCapabilities();
  });

  ipcMain.handle(HOST_IPC_CHANNELS.INVOKE, async (event, payload: unknown) => {
    const auth = authorizePrivilegedIpcSender(event, deps.getPrivilegedGuardOptions());
    if (!auth.ok) {
      deps.onPrivilegedIpcDenied?.(auth.error);
      return auth;
    }
    if (!payload || typeof payload !== 'object') {
      return hostErr('INVALID_PARAMS', 'IPC invoke payload must be an object');
    }
    const { capability, method, params } = payload as {
      capability?: unknown;
      method?: unknown;
      params?: unknown;
    };
    return await deps.registry.invoke(capability, method, params, {
      origin: auth.origin,
      url: auth.url,
      webContentsId: auth.webContentsId,
    });
  });

  ipcMain.handle(HOST_IPC_CHANNELS.SPLASH_RETRY, async event => {
    const auth = authorizeSplashOrMain(event, 'retryStartup');
    if (!auth.ok) return auth;
    await deps.loadStudioIntoMainWindow();
    return hostOk({ ok: true });
  });

  ipcMain.handle(HOST_IPC_CHANNELS.SPLASH_EXPORT_DIAGNOSTICS, async event => {
    const auth = authorizeSplashOrMain(event, 'exportDiagnostics');
    if (!auth.ok) return auth;
    const result = await deps.exportLogsWithDialog();
    return hostOk(result);
  });

  ipcMain.handle(HOST_IPC_CHANNELS.SPLASH_WINDOW_CONTROL, (event, action: unknown) => {
    const auth = authorizeSplashOrMain(event, 'windowControl');
    if (!auth.ok) return auth;
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed()) return hostOk({ ok: false });
    if (action === 'minimize') {
      win.minimize();
    } else if (action === 'toggleMaximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') {
      win.close();
    } else {
      return hostErr('INVALID_PARAMS', 'Unsupported window control action');
    }
    return hostOk({ ok: true });
  });

  ipcMain.handle(HOST_IPC_CHANNELS.SPLASH_RESET_ENV, async event => {
    if (!deps.envSwitcherEnabled) {
      return hostErr('POLICY_DENIED', 'Environment switching is disabled in stable releases');
    }
    const auth = authorizeSplashOrMain(event, 'resetEnvironment');
    if (!auth.ok) return auth;
    await deps.envController.switchEnvironment(null);
    return hostOk({ ok: true });
  });

  ipcMain.handle(HOST_IPC_CHANNELS.SPLASH_OPEN_ENV_SWITCHER, event => {
    if (!deps.envSwitcherEnabled) {
      return hostErr('POLICY_DENIED', 'Environment switching is disabled in stable releases');
    }
    const auth = authorizeSplashOrMain(event, 'openEnvironmentSwitcher');
    if (!auth.ok) return auth;
    deps.envController.openSwitcherWindow();
    return hostOk({ ok: true });
  });

  ipcMain.handle(HOST_IPC_CHANNELS.ENV_SWITCHER_GET_STATE, event => {
    const auth = authorizeEnvSwitcherSender(event, {
      channel: deps.releaseChannel,
      envSwitcherWindow: deps.envController.getSwitcherWindow(),
      allowedFilePaths: allowedEnvSwitcherFiles,
    });
    if (!auth.ok) return auth;
    return hostOk(deps.envController.buildSwitcherPayload());
  });

  ipcMain.handle(HOST_IPC_CHANNELS.ENV_SWITCHER_SELECT, async (event, payload: unknown) => {
    const auth = authorizeEnvSwitcherSender(event, {
      channel: deps.releaseChannel,
      envSwitcherWindow: deps.envController.getSwitcherWindow(),
      allowedFilePaths: allowedEnvSwitcherFiles,
    });
    if (!auth.ok) return auth;
    const rawUrl =
      payload && typeof payload === 'object' && typeof (payload as { url?: unknown }).url === 'string'
        ? (payload as { url: string }).url
        : '';
    const result = await deps.envController.switchEnvironment(rawUrl);
    if (!result.ok) {
      return hostErr('INVALID_PARAMS', result.reason);
    }
    deps.envController.closeSwitcherWindow();
    return hostOk({ ok: true, url: deps.resolveStudioUrl() });
  });

  ipcMain.handle(HOST_IPC_CHANNELS.ENV_SWITCHER_RESET, async event => {
    const auth = authorizeEnvSwitcherSender(event, {
      channel: deps.releaseChannel,
      envSwitcherWindow: deps.envController.getSwitcherWindow(),
      allowedFilePaths: allowedEnvSwitcherFiles,
    });
    if (!auth.ok) return auth;
    await deps.envController.switchEnvironment(null);
    deps.envController.closeSwitcherWindow();
    return hostOk({ ok: true, url: deps.resolveStudioUrl() });
  });

  ipcMain.handle(HOST_IPC_CHANNELS.ENV_SWITCHER_CLOSE, event => {
    const auth = authorizeEnvSwitcherSender(event, {
      channel: deps.releaseChannel,
      envSwitcherWindow: deps.envController.getSwitcherWindow(),
      allowedFilePaths: allowedEnvSwitcherFiles,
    });
    if (!auth.ok) return auth;
    deps.envController.closeSwitcherWindow();
    return hostOk({ ok: true });
  });

  ipcMain.on(HOST_IPC_CHANNELS.DOM_FULLSCREEN, (event, active: boolean) => {
    const auth = authorizePrivilegedIpcSender(event, deps.getPrivilegedGuardOptions());
    if (!auth.ok) return;
    deps.setDomFullscreen(Boolean(active));
    deps.broadcastChromeState();
  });

  deps.updater.subscribe(state => {
    deps.registry.emit(HOST_CAPABILITIES.UPDATER, 'state', state);
    deps.refreshDesktopMenus();
    if (deps.isManualUpdateCheckPending()) {
      void deps.maybePresentManualUpdateFeedback(state);
    } else if (
      state.status === 'downloaded' &&
      state.availableVersion &&
      state.availableVersion !== deps.getLastNotifiedDownloadedVersion()
    ) {
      deps.setLastNotifiedDownloadedVersion(state.availableVersion);
      const zh = deps.isZhAppLocale();
      deps.showDesktopNotification({
        title: zh ? 'OpenDesign 新版本已就绪' : 'OpenDesign Update Ready',
        body: zh
          ? `v${state.availableVersion} 已下载完成，点击立即重启安装。`
          : `v${state.availableVersion} is downloaded. Click to restart and install.`,
        whenUnfocusedOnly: false,
        onClick: () => {
          deps.focusOrRestoreMainWindow();
          deps.setManualUpdateCheckPending(true);
          void deps.maybePresentManualUpdateFeedback(deps.updater.getState());
        },
      });
    }
  });

  deps.authHandoff.subscribe(state => {
    deps.registry.emit(HOST_CAPABILITIES.ACCOUNT, 'state', state);
  });
}
