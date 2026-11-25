import { app, type BrowserWindow, dialog, nativeTheme } from 'electron';
import { existsSync, statSync } from 'node:fs';
import type { LocalAtomsRuntime } from '../../packages/local-atoms/index.ts';
import type { SignedConfigManager } from '../../packages/signed-config/index.ts';
import {
  HOST_CAPABILITIES,
  HOST_CAPABILITY_VERSIONS,
  hostErr,
  hostOk,
  type DesktopPreferencesSnapshot,
  type HostRuntimeInfo,
} from '../../shared/desktop-contract.ts';
import { validateHostMethodParams } from '../../shared/desktop-schemas.ts';
import type { DesktopTelemetryRecordInput } from '../../shared/desktop-telemetry.ts';
import type {
  DesktopChromeInsets,
  DesktopDiagnosticExportResult,
} from '../../shared/platform-host.ts';
import type { DesktopAuthHandoffManager } from './auth-handoff.ts';
import {
  type CapabilityModule,
  type CapabilityRegistry,
  createAccountCapabilityModule,
  createDiagnosticsCapabilityModule,
  createPreferencesCapabilityModule,
  createUpdaterCapabilityModule,
  createWindowCapabilityModule,
} from './capability-registry.ts';
import type { DesktopPreferencesStore } from './prefs.ts';
import type { DesktopSentryReporter } from './sentry.ts';
import type { DesktopTelemetryCollector } from './telemetry.ts';
import type { DesktopUpdaterController } from './updater.ts';
import {
  resolveDownloadDirectory,
  type TaskProgressCoordinator,
  type WakeLockManager,
} from './ux-controllers.ts';

export type RegisterDesktopCapabilitiesDeps = {
  registry: CapabilityRegistry;
  updater: DesktopUpdaterController;
  authHandoff: DesktopAuthHandoffManager;
  signedConfig: SignedConfigManager;
  telemetry: DesktopTelemetryCollector;
  desktopSentry: DesktopSentryReporter;
  desktopPrefs: DesktopPreferencesStore;
  atomsRuntime: LocalAtomsRuntime;
  progressCoordinator: TaskProgressCoordinator;
  wakeLockManager: WakeLockManager;
  getMainWindow: () => BrowserWindow | null;
  currentChromeState: () => DesktopChromeInsets;
  setThemePreference: (theme: 'light' | 'dark' | 'system') => void;
  applyResolvedTheme: (resolved: 'light' | 'dark') => void;
  openExternalSafe: (url: string) => Promise<{ ok: boolean; error?: string }>;
  onRendererReady: () => void;
  loadStudioIntoMainWindow: (targetPath?: string) => Promise<void>;
  showDesktopNotification: (options: {
    title: string;
    body?: string;
    bounce?: boolean;
    silent?: boolean;
    whenUnfocusedOnly?: boolean;
  }) => { delivered: boolean; bounced?: boolean };
  installDownloadedUpdate: () => Promise<{ ok: boolean; error?: string }>;
  buildRuntimeInfo: () => HostRuntimeInfo;
  exportLogsWithDialog: () => Promise<DesktopDiagnosticExportResult>;
  openLogsFolder: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  setInWindowAuthFallbackActive: (active: boolean) => void;
  startDesktopSignIn: (params?: {
    returnPath?: string;
    switchAccount?: boolean;
  }) => Promise<Record<string, unknown>>;
  openInWindowLoginFlow: (params?: {
    returnPath?: string;
    switchAccount?: boolean;
  }) => Promise<Record<string, unknown>>;
  maybeReloadMainWindowForSignedConfigChange: () => void;
  onSignedConfigApplied?: () => void;
  buildDesktopPreferencesSnapshot: () => DesktopPreferencesSnapshot;
  refreshDesktopMenus: (force?: boolean) => void;
  emitPreferencesChanged: () => void;
  clearStartupUpdateCheckTimer: () => void;
  getOpenAtLoginSupport: () => { supported: boolean; reason?: string };
  isZhAppLocale: () => boolean;
  markQuitConfirmed: () => void;
};

/**
 * Wires all built-in shell capability modules (`window`, `updater`,
 * `diagnostics`, `account`, `signedConfig`, `telemetry`, `preferences`) and
 * the five shared local atomic capabilities into the main-process registry.
 */
export function registerDesktopCapabilities(deps: RegisterDesktopCapabilitiesDeps): void {
  const { registry } = deps;

  registry.register(
    createWindowCapabilityModule({
      getChromeState: () => deps.currentChromeState(),
      setTheme: theme => {
        deps.setThemePreference(theme);
        nativeTheme.themeSource = theme;
        const resolved: 'light' | 'dark' =
          theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : theme;
        deps.applyResolvedTheme(resolved);
      },
      minimize: () => {
        deps.getMainWindow()?.minimize();
      },
      toggleMaximize: () => {
        const win = deps.getMainWindow();
        if (!win || win.isDestroyed()) return;
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
      },
      close: () => {
        deps.getMainWindow()?.close();
      },
      openExternal: url => deps.openExternalSafe(url),
      notifyRendererReady: () => {
        deps.onRendererReady();
      },
      retryStartup: async () => {
        await deps.loadStudioIntoMainWindow();
      },
      setTaskProgress: ({ taskId, progress }) => {
        deps.progressCoordinator.upsertTask(taskId, progress);
        return { progress: deps.progressCoordinator.getValue() };
      },
      acquireWakeLock: ({ taskId, reason, ttlMs }) =>
        deps.wakeLockManager.acquire(`task:${taskId}`, reason ?? 'studio-task', ttlMs),
      releaseWakeLock: ({ taskId }) => deps.wakeLockManager.release(`task:${taskId}`),
      notify: ({ title, body, bounce, silent, whenUnfocusedOnly }) =>
        deps.showDesktopNotification({
          title,
          body,
          bounce,
          silent,
          whenUnfocusedOnly: whenUnfocusedOnly ?? true,
        }),
    }),
  );

  registry.register(
    createUpdaterCapabilityModule({
      getUpdateState: () => deps.updater.getState(),
      checkForUpdates: async () => {
        const startedAt = Date.now();
        const state = await deps.updater.checkForUpdates();
        const endedAt = Date.now();
        const outcome = state.status === 'error' ? 'error' : 'ok';
        deps.telemetry.record({
          category: 'updater.check',
          outcome,
          durationMs: endedAt - startedAt,
          ...(state.availableVersion ? { targetVersion: state.availableVersion } : {}),
        });
        deps.desktopSentry.addBreadcrumb({
          category: 'updater',
          message: `Update check: ${state.status}`,
          level: outcome === 'error' ? 'warning' : 'info',
          ...(state.availableVersion ? { data: { availableVersion: state.availableVersion } } : {}),
        });
        void deps.desktopSentry.captureTransaction({
          name: 'desktop.updater.check',
          op: 'updater.check',
          startMs: startedAt,
          endMs: endedAt,
          status: outcome === 'ok' ? 'ok' : 'internal_error',
          tags: { outcome, status: state.status },
        });
        return state;
      },
      downloadUpdate: async () => {
        const startedAt = Date.now();
        const state = await deps.updater.downloadUpdate();
        const endedAt = Date.now();
        const outcome = state.status === 'error' ? 'error' : 'ok';
        deps.telemetry.record({
          category: 'updater.download',
          outcome,
          durationMs: endedAt - startedAt,
          ...(state.availableVersion ? { targetVersion: state.availableVersion } : {}),
        });
        deps.desktopSentry.addBreadcrumb({
          category: 'updater',
          message: `Update download: ${state.status}`,
          level: outcome === 'error' ? 'warning' : 'info',
          ...(state.availableVersion ? { data: { availableVersion: state.availableVersion } } : {}),
        });
        void deps.desktopSentry.captureTransaction({
          name: 'desktop.updater.download',
          op: 'updater.download',
          startMs: startedAt,
          endMs: endedAt,
          status: outcome === 'ok' ? 'ok' : 'internal_error',
          tags: { outcome, status: state.status },
        });
        return state;
      },
      installUpdateNow: () => deps.installDownloadedUpdate(),
    }),
  );

  registry.register(
    createDiagnosticsCapabilityModule({
      getAppInfo: () => deps.buildRuntimeInfo(),
      exportLogs: () => deps.exportLogsWithDialog(),
      openLogsFolder: () => deps.openLogsFolder(),
    }),
  );

  registry.register(
    createAccountCapabilityModule({
      startSignIn: async params => deps.startDesktopSignIn(params),
      cancelSignIn: () => deps.authHandoff.cancelLogin() as unknown as Record<string, unknown>,
      refreshAccount: () => deps.authHandoff.getState() as unknown as Record<string, unknown>,
      getLoginState: () => deps.authHandoff.getState() as unknown as Record<string, unknown>,
      openBillingPortal: async ({ url }) => deps.openExternalSafe(url),
      openInWindowLogin: async params => deps.openInWindowLoginFlow(params),
    }),
  );

  const signedConfigModule: CapabilityModule = {
    name: HOST_CAPABILITIES.SIGNED_CONFIG,
    version: HOST_CAPABILITY_VERSIONS[HOST_CAPABILITIES.SIGNED_CONFIG],
    status: 'available',
    events: ['updated'],
    methods: {
      getStatus: {
        handler: async () => hostOk(deps.signedConfig.getStatus()),
      },
      refresh: {
        handler: async () => {
          const startedAt = Date.now();
          const result = await deps.signedConfig.fetchAndApply();
          const endedAt = Date.now();
          const outcome = result.applied ? (result.unchanged ? 'unchanged' : 'applied') : 'rejected';
          deps.telemetry.record({
            category: 'signed_config.refresh',
            outcome,
            durationMs: endedAt - startedAt,
            ...(result.applied && typeof result.sequence === 'number'
              ? { sequence: result.sequence }
              : {}),
            ...(!result.applied && result.code ? { errorCode: result.code } : {}),
          });
          deps.desktopSentry.addBreadcrumb({
            category: 'config',
            message: `Signed config refresh: ${outcome}`,
            level: outcome === 'rejected' ? 'warning' : 'info',
          });
          void deps.desktopSentry.captureTransaction({
            name: 'desktop.signed_config.refresh',
            op: 'signed_config.refresh',
            startMs: startedAt,
            endMs: endedAt,
            status: outcome === 'rejected' ? 'internal_error' : 'ok',
            tags: { outcome },
          });
          if (result.applied && !result.unchanged) {
            deps.onSignedConfigApplied?.();
            registry.emit(HOST_CAPABILITIES.SIGNED_CONFIG, 'updated', deps.signedConfig.getStatus());
            deps.maybeReloadMainWindowForSignedConfigChange();
          }
          return hostOk(result);
        },
      },
    },
  };
  registry.register(signedConfigModule);

  const telemetryModule: CapabilityModule = {
    name: HOST_CAPABILITIES.TELEMETRY,
    version: HOST_CAPABILITY_VERSIONS[HOST_CAPABILITIES.TELEMETRY],
    status: 'available',
    methods: {
      getSummary: {
        handler: async params => {
          const checked = validateHostMethodParams(HOST_CAPABILITIES.TELEMETRY, 'getSummary', params);
          if (!checked.ok) return checked;
          return hostOk(deps.telemetry.getSummary());
        },
      },
      recordEvent: {
        handler: async params => {
          const checked = validateHostMethodParams<DesktopTelemetryRecordInput>(
            HOST_CAPABILITIES.TELEMETRY,
            'recordEvent',
            params,
          );
          if (!checked.ok) return checked;
          const recorded = deps.telemetry.record(checked.data);
          return hostOk({ recorded: Boolean(recorded), event: recorded });
        },
      },
      setEnabled: {
        handler: async params => {
          const checked = validateHostMethodParams<{ enabled: boolean }>(
            HOST_CAPABILITIES.TELEMETRY,
            'setEnabled',
            params,
          );
          if (!checked.ok) return checked;
          deps.desktopSentry.setEnabled(checked.data.enabled);
          return hostOk(deps.telemetry.setEnabled(checked.data.enabled));
        },
      },
      reset: {
        handler: async params => {
          const checked = validateHostMethodParams(HOST_CAPABILITIES.TELEMETRY, 'reset', params);
          if (!checked.ok) return checked;
          return hostOk(deps.telemetry.reset());
        },
      },
    },
  };
  registry.register(telemetryModule);

  registry.register(
    createPreferencesCapabilityModule({
      getAll: () => deps.buildDesktopPreferencesSnapshot(),
      set: async params => {
        switch (params.key) {
          case 'confirmBeforeQuit': {
            deps.desktopPrefs.update({ confirmBeforeQuit: params.value });
            deps.refreshDesktopMenus(true);
            const snapshot = deps.buildDesktopPreferencesSnapshot();
            deps.emitPreferencesChanged();
            return hostOk({
              key: 'confirmBeforeQuit',
              value: snapshot.values.confirmBeforeQuit,
              applied: 'immediate' as const,
              snapshot,
            });
          }
          case 'autoCheckUpdates': {
            deps.desktopPrefs.update({ autoCheckUpdates: params.value });
            if (!params.value) {
              deps.clearStartupUpdateCheckTimer();
            }
            const snapshot = deps.buildDesktopPreferencesSnapshot();
            deps.emitPreferencesChanged();
            return hostOk({
              key: 'autoCheckUpdates',
              value: snapshot.values.autoCheckUpdates,
              applied: 'immediate' as const,
              snapshot,
            });
          }
          case 'openAtLogin': {
            const loginSupport = deps.getOpenAtLoginSupport();
            if (!loginSupport.supported) {
              return hostErr(
                'UNSUPPORTED',
                loginSupport.reason || 'Launch at login is not supported in this host',
              );
            }
            try {
              app.setLoginItemSettings({ openAtLogin: params.value });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return hostErr('EXEC_FAILED', `Could not update login item setting: ${message}`);
            }
            const snapshot = deps.buildDesktopPreferencesSnapshot();
            deps.emitPreferencesChanged();
            return hostOk({
              key: 'openAtLogin',
              value: snapshot.values.openAtLogin,
              applied: 'immediate' as const,
              snapshot,
            });
          }
          case 'hardwareAcceleration': {
            deps.desktopPrefs.update({ hardwareAcceleration: params.value });
            const snapshot = deps.buildDesktopPreferencesSnapshot();
            deps.emitPreferencesChanged();
            return hostOk({
              key: 'hardwareAcceleration',
              value: snapshot.values.hardwareAcceleration,
              applied: 'restart-required' as const,
              snapshot,
            });
          }
          case 'locale': {
            deps.desktopPrefs.update({ locale: params.value });
            deps.refreshDesktopMenus(true);
            const snapshot = deps.buildDesktopPreferencesSnapshot();
            deps.emitPreferencesChanged();
            return hostOk({
              key: 'locale',
              value: snapshot.values.locale,
              applied: 'immediate' as const,
              snapshot,
            });
          }
        }
      },
      reset: async params => {
        if (!params.key) {
          deps.desktopPrefs.reset();
          if (deps.getOpenAtLoginSupport().supported) {
            try {
              app.setLoginItemSettings({ openAtLogin: false });
            } catch {
              // Ignore login item reset failure when OS blocks changes.
            }
          }
        } else if (params.key === 'openAtLogin') {
          const loginSupport = deps.getOpenAtLoginSupport();
          if (!loginSupport.supported) {
            return hostErr(
              'UNSUPPORTED',
              loginSupport.reason || 'Launch at login is not supported in this host',
            );
          }
          try {
            app.setLoginItemSettings({ openAtLogin: false });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return hostErr('EXEC_FAILED', `Could not reset login item setting: ${message}`);
          }
        } else {
          deps.desktopPrefs.reset(params.key);
        }
        deps.refreshDesktopMenus(true);
        const snapshot = deps.buildDesktopPreferencesSnapshot();
        deps.emitPreferencesChanged();
        return hostOk(snapshot);
      },
      pickDownloadDir: async () => {
        const zh = deps.isZhAppLocale();
        const defaultPath = resolveDownloadDirectory(
          deps.desktopPrefs.get().lastDownloadDir,
          app.getPath('downloads'),
        );
        const mainWindow = deps.getMainWindow();
        const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
        const dialogOptions = {
          title: zh ? '选择默认下载文件夹' : 'Choose Default Download Folder',
          defaultPath,
          properties: ['openDirectory', 'createDirectory'] as Array<
            'openDirectory' | 'createDirectory'
          >,
        };
        const result = parent
          ? await dialog.showOpenDialog(parent, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
        if (result.canceled || !result.filePaths[0]) {
          return hostOk({
            canceled: true,
            path: deps.desktopPrefs.get().lastDownloadDir ?? null,
            snapshot: deps.buildDesktopPreferencesSnapshot(),
          });
        }
        const selectedPath = result.filePaths[0].trim();
        try {
          if (!selectedPath || !existsSync(selectedPath) || !statSync(selectedPath).isDirectory()) {
            return hostErr('INVALID_PARAMS', 'Selected path is not a valid directory');
          }
        } catch {
          return hostErr('INVALID_PARAMS', 'Selected path could not be accessed');
        }
        deps.desktopPrefs.update({ lastDownloadDir: selectedPath });
        const snapshot = deps.buildDesktopPreferencesSnapshot();
        deps.emitPreferencesChanged();
        return hostOk({
          canceled: false,
          path: selectedPath,
          snapshot,
        });
      },
      relaunch: async () => {
        deps.markQuitConfirmed();
        app.relaunch();
        setImmediate(() => {
          app.quit();
        });
        return hostOk({ relaunching: true });
      },
    }),
  );

  for (const [capName, atomHandler] of Object.entries(deps.atomsRuntime.capabilities)) {
    const methods: CapabilityModule['methods'] = {};
    for (const methodName of atomHandler.descriptor.methods ?? []) {
      methods[methodName] = {
        handler: async params => atomHandler.invoke(methodName, params),
      };
    }
    if (capName === HOST_CAPABILITIES.ATOM_DETECT) {
      methods.detect = { handler: async params => atomHandler.invoke('scan', params) };
    }
    registry.register({
      name: atomHandler.descriptor.name,
      version: atomHandler.descriptor.version,
      status: atomHandler.descriptor.status,
      ...(atomHandler.descriptor.reason ? { reason: atomHandler.descriptor.reason } : {}),
      methods,
      ...(atomHandler.descriptor.events ? { events: atomHandler.descriptor.events } : {}),
    });
  }
}
