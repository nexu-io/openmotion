import { app, BrowserWindow, clipboard, crashReporter, dialog, Menu, nativeTheme, net, Notification, powerSaveBlocker, safeStorage, screen, session, shell } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_STUDIO_URLS,
  DESKTOP_APP_ID,
  DESKTOP_DATA_LAYOUT_VERSION,
  DESKTOP_PRODUCT_NAME,
  DESKTOP_PROTOCOL_SCHEME,
  isUrlInAllowedDomainScope,
  DEFAULT_SIGNED_CONFIG_BASE_URL,
} from '../../shared/desktop-builtin-rules.ts';
import {
  HOST_CAPABILITIES,
  HOST_CONTRACT_VERSION,
  type DesktopPreferenceDescriptor,
  type DesktopPreferenceKey,
  type DesktopPreferencesSnapshot,
  type HostConfirmationRequest,
  type HostPlatform,
  type HostReleaseChannel,
  type HostRuntimeInfo,
} from '../../shared/desktop-contract.ts';
import type {
  DesktopChromeInsets,
  DesktopDiagnosticExportResult,
  DesktopMenuAction,
} from '../../shared/platform-host.ts';
import {
  createEncryptedFileSecretStore,
  createLocalAtomsRuntime,
  createMacOsKeychainSecretStore,
} from '../../packages/local-atoms/index.ts';
import { SignedConfigManager } from '../../packages/signed-config/index.ts';
import {
  DesktopAuthHandoffManager,
  parseStudioAuthNavigationUrl,
  probeDesktopHandoffSupport,
  sanitizeAuthReturnPath,
} from './auth-handoff.ts';
import { createElectronSafeSecretStore } from './safe-secret-store.ts';
import { createDesktopSentryReporter, resolveDesktopSentryDsn } from './sentry.ts';
import { classifyLoadFailure, createIncidentId, probeConnectivity } from './startup-health.ts';
import { createSessionTracker, hasCrashDumpSince } from './session-health.ts';
import { DesktopTelemetryCollector } from './telemetry.ts';
import {
  CapabilityRegistry,
  createWebContentsEventSink,
} from './capability-registry.ts';
import { ensureDesktopDataLayout } from './data-layout.ts';
import {
  authorizePrivilegedIpcSender,
  resolveAllowedStudioOrigins,
  type PrivilegedIpcGuardOptions,
} from './ipc-guard.ts';
import { createDesktopDiagnosticZip, DesktopLogger } from './logger.ts';
import { buildDesktopDockMenuTemplate, buildDesktopMenuTemplate } from './menu.ts';
import { attachNativeContextMenu } from './context-menu.ts';
import {
  buildDesktopChromeCss,
  buildMainWindowOptions,
  DEFAULT_MAIN_WINDOW_BOUNDS,
  getDesktopWindowBackgroundColor,
  getWindowsTitleBarOverlay,
  normalizeDesktopPlatform,
  resolveDesktopChrome,
} from './platform.ts';
import {
  DesktopProtocolRouter,
  extractDeepLinkFromArgv,
  registerDesktopProtocolClient,
} from './protocol.ts';
import { DesktopUpdaterController, resolvePackagedReleaseChannel } from './updater.ts';
import {
  attachWindowNavigationPolicies,
  isAllowedExternalUrl,
  resolveDefaultFallbackAuthOrigins,
  type PolicyWebContentsLike,
  type WindowPolicyConfig,
} from './window-policy.ts';
import {
  readWindowState,
  resolveRestoredWindowBounds,
  writeWindowState,
} from './window-state.ts';
import { DesktopPreferencesStore, resolveDesktopPreferenceValues } from './prefs.ts';
import {
  DesktopEnvironmentStore,
  describeDesktopEnvironment,
  extractStudioUrlFromArgv,
  isEnvironmentSwitcherEnabled,
  parseExtraAllowedEnvDomains,
  resolveEnvironmentSessionPartition,
  validateTestEnvironmentUrl,
  type TestEnvironmentValidationOptions,
} from './env-switcher.ts';
import {
  buildRendererCrashRetryInfo,
  isSafeHistoryNavigationTarget,
  RendererCrashGuard,
  resolveUpdaterMenuPresentation,
  TaskProgressCoordinator,
  WakeLockManager,
} from './ux-controllers.ts';
import { createBootOverlayController } from './main-boot-overlay.ts';
import { registerDesktopCapabilities } from './main-capabilities.ts';
import {
  createManualUpdateFeedbackPresenter,
  createSessionDownloadController,
} from './main-downloads.ts';
import { createDesktopEnvironmentController } from './main-env-runtime.ts';
import { registerDesktopIpc } from './main-ipc.ts';

const __filename = fileURLToPath(import.meta.url);
const distDir = path.dirname(__filename);
const platform: HostPlatform = normalizeDesktopPlatform(process.platform);

app.setName(DESKTOP_PRODUCT_NAME);
if (!process.argv.some(arg => arg.startsWith('--user-data-dir'))) {
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'OpenMotion'));
  } catch {
    // Ignore custom userData override failure on restricted hosts.
  }
}

const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
  process.exit(0);
}

function readBundledPackageChannel(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), 'package.json'),
    path.resolve(distDir, '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
        openmotionChannel?: unknown;
      };
      if (typeof parsed.openmotionChannel === 'string' && parsed.openmotionChannel.trim()) {
        return parsed.openmotionChannel.trim();
      }
    } catch {
      // Ignore unreadable package metadata and continue fallback chain.
    }
  }
  return undefined;
}

function readBundledAppUpdateYml(): string | undefined {
  if (!app.isPackaged || !process.resourcesPath) return undefined;
  const candidate = path.join(process.resourcesPath, 'app-update.yml');
  try {
    if (!existsSync(candidate)) return undefined;
    return readFileSync(candidate, 'utf8');
  } catch {
    return undefined;
  }
}

function resolveReleaseChannel(): HostReleaseChannel {
  return resolvePackagedReleaseChannel({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    envChannel: process.env.MOTION_DESKTOP_CHANNEL,
    packageChannel: readBundledPackageChannel(),
    appUpdateYmlContent: readBundledAppUpdateYml(),
  });
}

const releaseChannel = resolveReleaseChannel();
const allowLocalDevLoopback = releaseChannel === 'dev' && !app.isPackaged;
const userDataRoot = app.getPath('userData');
const dataLayout = ensureDesktopDataLayout(userDataRoot);
const logDir = dataLayout.paths.logsDir;
const dataDir = dataLayout.paths.rootDir;

function resolveIconPath(): string | undefined {
  for (const file of ['app-icon.png', 'apple-touch-icon.png']) {
    const candidate = path.join(distDir, 'brand', file);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const logger = new DesktopLogger({
  logDir,
  redactPaths: [distDir, dataDir, logDir, os.homedir()],
});

const telemetry = new DesktopTelemetryCollector({
  dataDir,
  channel: releaseChannel,
  platform,
  arch: process.arch,
  shellVersion: app.getVersion(),
  allowLocalDevLoopback,
});
const appStartupStartedAt = Date.now();
let appReadyAt: number | null = null;
let windowCreatedAt: number | null = null;
let studioLoadStartedAt: number | null = null;
let domReadyAt: number | null = null;
let didFinishLoadAt: number | null = null;

function sanitizeUrlForBreadcrumb(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl.split('?')[0] ?? rawUrl;
  }
}

const desktopRelease = `openmotion-desktop@${app.getVersion()}`;
let sessionTracker: ReturnType<typeof createSessionTracker>;
const desktopSentry = createDesktopSentryReporter({
  dsn: resolveDesktopSentryDsn(),
  environment: process.env.SENTRY_ENVIRONMENT,
  release: desktopRelease,
  channel: releaseChannel,
  platform,
  arch: process.arch,
  shellVersion: app.getVersion(),
  appDistDir: distDir,
  redactPaths: [distDir, dataDir, logDir, os.homedir()],
  outboxPath: path.join(dataDir, 'telemetry', 'sentry-outbox.json'),
  getInstallId: () => sessionTracker?.getInstallId(),
  osVersion: os.release(),
  electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
  nodeVersion: process.versions.node,
  appStartTime: appStartupStartedAt,
  // Chromium's network stack follows the system proxy; Node's fetch does not.
  fetchImpl: (input, init) =>
    app.isReady() ? net.fetch(input instanceof URL ? input.toString() : input, init) : fetch(input, init),
  onCapture: level => {
    if (level === 'error' || level === 'fatal') sessionTracker?.noteError();
  },
  onDisabled: () => sessionTracker?.forget(),
});
sessionTracker = createSessionTracker({
  dir: path.join(dataDir, 'telemetry'),
  release: desktopRelease,
  isEnabled: () => desktopSentry.isEnabled(),
  send: update => void desktopSentry.sendSession(update),
  hasCrashDumpSince: sinceMs => hasCrashDumpSince(app.getPath('crashDumps'), sinceMs),
});
// Honor the persisted sharing preference before Studio loads and syncs it.
desktopSentry.setEnabled(telemetry.isEnabled());
desktopSentry.startCrashReporter(crashReporter);
desktopSentry.addBreadcrumb({
  category: 'lifecycle',
  message: 'Desktop shell booted',
  data: { channel: releaseChannel, isPackaged: app.isPackaged },
});
// Report this launch for release health, and deliver what an earlier launch could not
// send (it may have failed while offline).
void app.whenReady().then(() => {
  sessionTracker.start();
  return desktopSentry.flushOutbox();
});

const previousSession = logger.markSessionStarted({
  version: app.getVersion(),
  platform,
  arch: process.arch,
});
if (previousSession.previousExitUnclean) {
  void desktopSentry.captureMessage('Previous session ended without a clean exit', 'warning', {
    area: 'lifecycle',
    tags: { previous_version: previousSession.previousVersion ?? 'unknown' },
  });
}

const signedConfig = new SignedConfigManager({
  dataDir: dataLayout.paths.configDir,
  channel: releaseChannel,
  allowLocalDevLoopback,
});

const envSwitcherEnabled = isEnvironmentSwitcherEnabled(releaseChannel);
const envValidationOptions: TestEnvironmentValidationOptions = {
  channel: releaseChannel,
  ...(envSwitcherEnabled
    ? {
        extraAllowedDomains: parseExtraAllowedEnvDomains(
          process.env.OPENMOTION_DESKTOP_ALLOWED_ENV_DOMAINS,
        ),
      }
    : {}),
};
const envStore = envSwitcherEnabled
  ? new DesktopEnvironmentStore(
      path.join(dataLayout.paths.configDir, 'dev-env.json'),
      envValidationOptions,
    )
  : null;
let cliStudioUrlOverride: string | undefined = extractStudioUrlFromArgv(
  process.argv,
  envValidationOptions,
);

function resolveBaseDefaultStudioUrl(): string {
  const envOverride = !app.isPackaged ? process.env.MOTION_DESKTOP_STUDIO_URL?.trim() : undefined;
  if (
    envOverride &&
    isUrlInAllowedDomainScope(envOverride, { channel: releaseChannel, allowLocalDevLoopback })
  ) {
    return envOverride;
  }
  const active = signedConfig.getActiveConfig();
  if (
    active.studioUrl &&
    isUrlInAllowedDomainScope(active.studioUrl, { channel: releaseChannel, allowLocalDevLoopback })
  ) {
    return active.studioUrl;
  }
  return DEFAULT_STUDIO_URLS[releaseChannel];
}

function resolveStudioUrl(): string {
  if (envSwitcherEnabled) {
    if (cliStudioUrlOverride) {
      return cliStudioUrlOverride;
    }
    const persisted = envStore?.get().overrideUrl;
    if (persisted) {
      const checked = validateTestEnvironmentUrl(persisted, envValidationOptions);
      if (checked.ok) {
        return checked.normalizedUrl;
      }
    }
  }
  return resolveBaseDefaultStudioUrl();
}

function resolveStudioOrigin(): string {
  return new URL(resolveStudioUrl()).origin;
}

function resolveExplicitTestStudioOrigin(): string | undefined {
  if (!envSwitcherEnabled) return undefined;
  const activeUrl = resolveStudioUrl();
  const checked = validateTestEnvironmentUrl(activeUrl, envValidationOptions);
  if (!checked.ok) return undefined;
  const inDefaultScope = isUrlInAllowedDomainScope(checked.origin, {
    channel: releaseChannel,
    allowLocalDevLoopback,
  });
  return inDefaultScope ? undefined : checked.origin;
}

function resolveCurrentEnvironmentDescription() {
  return describeDesktopEnvironment(resolveStudioUrl(), {
    channel: releaseChannel,
    defaultUrl: resolveBaseDefaultStudioUrl(),
  });
}

function resolveCurrentSessionPartition(): string | undefined {
  if (!envSwitcherEnabled) return undefined;
  return resolveEnvironmentSessionPartition(resolveStudioUrl(), resolveBaseDefaultStudioUrl());
}

const linuxCustomTitleBar = process.env.MOTION_LINUX_NATIVE_FRAME !== '1';
const windowStatePath = path.join(dataDir, 'window-state.json');
const desktopPrefs = new DesktopPreferencesStore(
  path.join(dataLayout.paths.configDir, 'desktop-prefs.json'),
);
const bootHardwareAcceleration = desktopPrefs.get().hardwareAcceleration !== false;
if (!bootHardwareAcceleration) {
  try {
    app.disableHardwareAcceleration();
  } catch {
    // Ignore if hardware acceleration cannot be disabled on this host build.
  }
}
const crashGuard = new RendererCrashGuard();
const wakeLockManager = new WakeLockManager({
  start: () => powerSaveBlocker.start('prevent-app-suspension'),
  stop: id => powerSaveBlocker.stop(id),
});
const progressCoordinator = new TaskProgressCoordinator(value => {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    win.setProgressBar(value);
  } catch {
    // Ignore progress bar failures on unsupported desktop environments.
  }
});
let mainWindow: BrowserWindow | null = null;
let domFullscreen = false;
let themePreference: 'system' | 'light' | 'dark' = 'system';
let currentTheme: 'light' | 'dark' = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
let rendererReady = false;
let shuttingDown = false;
let quitConfirmed = false;
let quitPromptOpen = false;
let inWindowAuthFallbackActive = false;
let showingRetryPage = false;
let manualUpdateCheckPending = false;
let lastNotifiedDownloadedVersion: string | null = null;
let lastMenuStateSignature = '';
let pendingMenuActions: DesktopMenuAction[] = [];
const MAX_PENDING_MENU_ACTIONS = 32;
let signedConfigRefreshTimer: ReturnType<typeof setInterval> | null = null;
let windowStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
let startupLoadWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;
let unresponsiveDialogOpen = false;
let lastNormalWindowBounds: { x: number; y: number; width: number; height: number } | null = null;
let shouldRestoreMaximized = false;
let activeWindowPartition: string | undefined;
let switchingMainWindow = false;

const STARTUP_LOAD_TIMEOUT_MS = 18_000;
const UNRESPONSIVE_PROMPT_DELAY_MS = 8_000;

const protocolRouter = new DesktopProtocolRouter({
  allowEnvParam: envSwitcherEnabled,
  envValidation: envValidationOptions,
  onActivateMainWindow: link => {
    void handleDeepLinkOpen(link.params);
  },
});
protocolRouter.subscribe(link => {
  registry.emit(HOST_CAPABILITIES.WINDOW, 'deepLink', link);
});

const updater = new DesktopUpdaterController({
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  channel: releaseChannel === 'stable' ? 'stable' : 'test',
  feedUrl: !app.isPackaged ? process.env.MOTION_DESKTOP_UPDATE_URL?.trim() || undefined : undefined,
});

function syncUpdaterPolicyFromSignedConfig(options?: { triggerCheckIfMandatory?: boolean }): void {
  const active = signedConfig.getActiveConfig();
  const nextState = updater.setMinimumVersionPolicy({
    minRequiredVersion: active.minShellVersion,
    reason: active.minShellVersionReason,
    downloadUrl: active.updateDownloadUrl,
  });
  if (
    options?.triggerCheckIfMandatory &&
    nextState.mandatory &&
    app.isPackaged &&
    (nextState.status === 'idle' || nextState.status === 'up-to-date')
  ) {
    void updater.checkForUpdates().catch(() => {});
  }
}

syncUpdaterPolicyFromSignedConfig();

let pendingLoginReturnPath: string | undefined;
const handoffSupportCache = new Map<string, { supported: boolean; checkedAt: number }>();
const HANDOFF_PROBE_CACHE_TTL_MS = 30_000;

const authHandoff = new DesktopAuthHandoffManager({
  getStudioOrigin: () => resolveStudioOrigin(),
  openExternal: async url => {
    await shell.openExternal(url);
  },
  exchangeFetch: async (url, init) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (!win) {
      throw new Error('Main window is unavailable for session exchange');
    }
    const response = await win.webContents.session.fetch(url, {
      ...init,
      credentials: 'include',
    });
    if (response.ok) {
      await win.webContents.session.cookies.flushStore().catch(() => {});
    }
    return response;
  },
  onFocusMainWindow: () => {
    inWindowAuthFallbackActive = false;
    const returnPath = pendingLoginReturnPath;
    pendingLoginReturnPath = undefined;
    focusOrRestoreMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      void loadStudioIntoMainWindow(returnPath);
    }
  },
});

async function isDesktopHandoffSupportedForOrigin(studioOrigin: string): Promise<boolean> {
  const cached = handoffSupportCache.get(studioOrigin);
  if (cached && Date.now() - cached.checkedAt < HANDOFF_PROBE_CACHE_TTL_MS) {
    return cached.supported;
  }
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const probeFetch = win
    ? (url: string, init: { method: 'GET'; redirect: 'manual'; signal?: AbortSignal }) =>
        win.webContents.session.fetch(url, init)
    : (url: string, init: { method: 'GET'; redirect: 'manual'; signal?: AbortSignal }) => fetch(url, init);
  const supported = await probeDesktopHandoffSupport(studioOrigin, probeFetch);
  handoffSupportCache.set(studioOrigin, { supported, checkedAt: Date.now() });
  return supported;
}

async function openInWindowLoginFlow(params?: {
  returnPath?: string;
  switchAccount?: boolean;
}): Promise<Record<string, unknown>> {
  const returnPath = sanitizeAuthReturnPath(params?.returnPath);
  inWindowAuthFallbackActive = true;
  const loginUrl = authHandoff.openInWindowFallback({
    returnPath,
    switchAccount: params?.switchAccount,
  });
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (win) {
    try {
      await win.loadURL(loginUrl);
    } catch (error) {
      inWindowAuthFallbackActive = false;
      throw error;
    }
  }
  return { mode: 'in-window', state: 'in-window', url: loginUrl };
}

async function startDesktopSignIn(params?: {
  returnPath?: string;
  switchAccount?: boolean;
}): Promise<Record<string, unknown>> {
  const studioOrigin = resolveStudioOrigin();
  const returnPath = sanitizeAuthReturnPath(params?.returnPath);
  const supported = await isDesktopHandoffSupportedForOrigin(studioOrigin);
  if (!supported) {
    logger.info('main', 'Desktop PKCE handoff route unavailable on Studio origin; using in-window sign-in', {
      studioOrigin,
    });
    return await openInWindowLoginFlow({
      returnPath,
      switchAccount: params?.switchAccount,
    });
  }

  const startedAt = Date.now();
  pendingLoginReturnPath = returnPath;
  desktopSentry.addBreadcrumb({
    category: 'auth',
    message: 'Started desktop browser sign-in',
    data: { switchAccount: Boolean(params?.switchAccount) },
  });
  try {
    const result = await authHandoff.startLogin({
      switchAccount: params?.switchAccount,
    });
    void result.completion
      .then(finalState => {
        if (finalState.status !== 'authenticated') {
          pendingLoginReturnPath = undefined;
        }
        const endedAt = Date.now();
        const outcome =
          finalState.status === 'authenticated'
            ? 'authenticated'
            : finalState.status === 'canceled'
              ? 'cancelled'
              : finalState.errorCode === 'TIMEOUT'
                ? 'timeout'
                : 'error';
        telemetry.record({
          category: 'auth.handoff',
          outcome,
          durationMs: endedAt - startedAt,
        });
        desktopSentry.addBreadcrumb({
          category: 'auth',
          message: `Desktop sign-in finished: ${outcome}`,
          level: outcome === 'error' || outcome === 'timeout' ? 'warning' : 'info',
        });
        void desktopSentry.captureTransaction({
          name: 'desktop.auth.handoff',
          op: 'auth.handoff',
          startMs: startedAt,
          endMs: endedAt,
          status:
            outcome === 'authenticated'
              ? 'ok'
              : outcome === 'cancelled'
                ? 'cancelled'
                : outcome === 'timeout'
                  ? 'deadline_exceeded'
                  : 'internal_error',
          tags: { outcome },
          measurements: {
            auth_handoff_ms: { value: Math.max(0, endedAt - startedAt), unit: 'millisecond' },
          },
        });
      })
      .catch(() => {
        const endedAt = Date.now();
        pendingLoginReturnPath = undefined;
        telemetry.record({
          category: 'auth.handoff',
          outcome: 'error',
          durationMs: endedAt - startedAt,
        });
        void desktopSentry.captureTransaction({
          name: 'desktop.auth.handoff',
          op: 'auth.handoff',
          startMs: startedAt,
          endMs: endedAt,
          status: 'internal_error',
          tags: { outcome: 'error' },
        });
      });
    // Return only structuredClone-safe plain fields over Electron IPC (never return the completion Promise).
    return {
      mode: 'browser-handoff',
      url: result.startUrl,
      startUrl: result.startUrl,
      redirectUri: result.redirectUri,
      state: result.state,
      codeChallenge: result.codeChallenge,
    };
  } catch (error) {
    pendingLoginReturnPath = undefined;
    telemetry.record({
      category: 'auth.handoff',
      outcome: 'error',
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

function formatConfirmationDetail(request: HostConfirmationRequest): string {
  const lines = [
    `Feature: ${request.featureTitle} (v${request.featureVersion})`,
    '',
    'This action will perform the following operations on your computer:',
  ];
  for (const fact of request.facts) {
    lines.push(`• ${fact.label}: ${fact.value}`);
  }
  return lines.join('\n');
}

async function confirmFeatureWithDialog(request: HostConfirmationRequest): Promise<boolean> {
  const parent =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getFocusedWindow() ?? undefined;
  const options = {
    type: 'question' as const,
    title: 'Confirm Local Action',
    message: `Allow ${request.featureTitle}?`,
    detail: formatConfirmationDetail(request),
    buttons: ['Cancel', 'Allow'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  };
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

const desktopSecretStore = createElectronSafeSecretStore({
  dataDir,
  safeStorage,
  fallbackStore:
    platform === 'darwin'
      ? createMacOsKeychainSecretStore()
      : createEncryptedFileSecretStore(path.join(dataDir, 'credentials.enc')),
});

const atomsRuntime = createLocalAtomsRuntime({
  dataDir,
  platform,
  arch: process.arch,
  channel: releaseChannel,
  allowLocalDevLoopback,
  appBundlePath: app.isPackaged ? process.resourcesPath : undefined,
  getExpectedMcpUrl: () => `${resolveStudioOrigin()}/mcp`,
  shellVersion: app.getVersion(),
  getSignedConfig: () => signedConfig.getActiveConfig(),
  confirmCallback: confirmFeatureWithDialog,
  secretStore: desktopSecretStore,
});

const registry = new CapabilityRegistry({
  sinks: [
    createWebContentsEventSink(() => {
      const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
      if (!wc) return null;
      const auth = authorizePrivilegedIpcSender(
        { sender: wc, senderFrame: wc.mainFrame },
        getPrivilegedGuardOptions(),
      );
      return auth.ok ? wc : null;
    }),
  ],
  onInternalError: ({ capability, method, error }) => {
    logger.error('main', `Capability error in ${capability}.${method}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    void desktopSentry.captureException(error, {
      area: 'capability',
      tags: { capability, method },
    });
  },
});

function currentChromeState(): DesktopChromeInsets {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const fullscreen = Boolean(win?.isFullScreen() || domFullscreen);
  const maximized = Boolean(win?.isMaximized());
  const zoomFactor = win ? win.webContents.getZoomFactor() : 1;
  return resolveDesktopChrome({
    platform,
    fullscreen,
    maximized,
    linuxCustomTitleBar,
    zoomFactor,
  });
}

function adjustMainWindowZoom(direction: 'in' | 'out' | 'reset'): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (direction === 'reset') {
    wc.setZoomFactor(1);
  } else {
    const current = wc.getZoomFactor();
    const next =
      direction === 'in'
        ? Math.min(2, Math.round((current + 0.1) * 10) / 10)
        : Math.max(0.5, Math.round((current - 0.1) * 10) / 10);
    wc.setZoomFactor(next);
  }
  broadcastChromeState();
}

let injectedChromeCssKey: string | null = null;
let chromeCssGeneration = 0;
let liveResizingActive = false;
let liveResizeIdleTimer: ReturnType<typeof setTimeout> | null = null;
const LIVE_RESIZE_SETTLE_MS = 120;

function setLiveResizing(active: boolean): void {
  if (liveResizingActive === active) return;
  liveResizingActive = active;
  registry.emit(HOST_CAPABILITIES.WINDOW, 'resizing', { active });
}

function markLiveResizing(): void {
  if (liveResizeIdleTimer) {
    clearTimeout(liveResizeIdleTimer);
  }
  setLiveResizing(true);
  liveResizeIdleTimer = setTimeout(() => {
    liveResizeIdleTimer = null;
    setLiveResizing(false);
  }, LIVE_RESIZE_SETTLE_MS);
}

function finishLiveResizing(): void {
  if (liveResizeIdleTimer) {
    clearTimeout(liveResizeIdleTimer);
    liveResizeIdleTimer = null;
  }
  setLiveResizing(false);
}

async function syncWindowChromeCss(): Promise<void> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  const currentUrl = wc.getURL();
  if (!currentUrl || (!currentUrl.startsWith('https://') && !currentUrl.startsWith('http://'))) {
    return;
  }
  const gen = ++chromeCssGeneration;
  const css = buildDesktopChromeCss(currentChromeState());
  if (!css) {
    const prevKey = injectedChromeCssKey;
    injectedChromeCssKey = null;
    if (prevKey) {
      await wc.removeInsertedCSS(prevKey).catch(() => {});
    }
    return;
  }
  try {
    const nextKey = await wc.insertCSS(css);
    if (win.isDestroyed() || gen !== chromeCssGeneration) {
      await wc.removeInsertedCSS(nextKey).catch(() => {});
      return;
    }
    const prevKey = injectedChromeCssKey;
    injectedChromeCssKey = nextKey;
    if (prevKey && prevKey !== nextKey) {
      await wc.removeInsertedCSS(prevKey).catch(() => {});
    }
  } catch {
    // Ignore CSS injection failures during navigation teardown.
  }
}

function broadcastChromeState(): void {
  const state = currentChromeState();
  registry.emit(HOST_CAPABILITIES.WINDOW, 'chromeState', state);
  void syncWindowChromeCss();
}

function focusOrRestoreMainWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function buildRuntimeInfo(): HostRuntimeInfo {
  const envDesc = resolveCurrentEnvironmentDescription();
  return {
    hostKind: 'desktop',
    shellVersion: app.getVersion(),
    contractVersion: HOST_CONTRACT_VERSION,
    platform,
    arch: process.arch,
    releaseChannel,
    isPackaged: app.isPackaged,
    appId: DESKTOP_APP_ID,
    productName: DESKTOP_PRODUCT_NAME,
    protocolScheme: DESKTOP_PROTOCOL_SCHEME,
    electronVersion: process.versions.electron ?? '',
    chromeVersion: process.versions.chrome ?? '',
    nodeVersion: process.versions.node ?? '',
    dataDir,
    logDir,
    dataLayoutVersion: DESKTOP_DATA_LAYOUT_VERSION,
    activeStudioUrl: envDesc.url,
    environmentLabel: envDesc.label,
    isCustomEnvironment: envDesc.isCustomOverride,
  };
}

function getPrivilegedGuardOptions(): PrivilegedIpcGuardOptions {
  const active = signedConfig.getActiveConfig();
  return {
    mainWindow,
    channel: releaseChannel,
    studioUrl: resolveStudioUrl(),
    allowedOrigins: active.allowedOrigins,
    allowLocalDevLoopback,
    explicitTestStudioOrigin: resolveExplicitTestStudioOrigin(),
    inWindowAuthFallbackActive,
  };
}

function maybeReloadMainWindowForSignedConfigChange(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed() || showingRetryPage) return;
  const currentUrl = win.webContents.getURL();
  if (!currentUrl || currentUrl.startsWith('file://')) return;
  try {
    const currentOrigin = new URL(currentUrl).origin;
    const active = signedConfig.getActiveConfig();
    const allowedOrigins = resolveAllowedStudioOrigins({
      channel: releaseChannel,
      studioUrl: resolveStudioUrl(),
      allowedOrigins: active.allowedOrigins,
      allowLocalDevLoopback,
      explicitTestStudioOrigin: resolveExplicitTestStudioOrigin(),
    });
    if (!allowedOrigins.has(currentOrigin)) {
      logger.info('main', 'Reloading Studio after signed config origin migration', {
        previousOrigin: currentOrigin,
        nextUrl: resolveStudioUrl(),
      });
      void loadStudioIntoMainWindow();
    }
  } catch {
    // Ignore malformed current URL.
  }
}

function getWindowPolicyConfig(): WindowPolicyConfig {
  const active = signedConfig.getActiveConfig();
  return {
    studioOrigin: resolveStudioOrigin(),
    channel: releaseChannel,
    allowedOrigins: active.allowedOrigins,
    windowPolicy: active.windowPolicy,
    explicitIdpAuthOrigins: resolveDefaultFallbackAuthOrigins(releaseChannel),
    inWindowAuthFallbackActive,
    allowLocalDevLoopback,
    explicitTestStudioOrigin: resolveExplicitTestStudioOrigin(),
  };
}

function queuePendingMenuAction(action: DesktopMenuAction): void {
  if (pendingMenuActions.length >= MAX_PENDING_MENU_ACTIONS) {
    pendingMenuActions.shift();
  }
  pendingMenuActions.push(action);
}

function getEffectiveAppLocale(): string {
  return desktopPrefs.get().locale || app.getLocale();
}

function isZhAppLocale(): boolean {
  return getEffectiveAppLocale().toLowerCase().startsWith('zh');
}

function isConfirmBeforeQuitEnabled(): boolean {
  return desktopPrefs.get().confirmBeforeQuit !== false;
}

function isAutoCheckUpdatesEnabled(): boolean {
  return desktopPrefs.get().autoCheckUpdates !== false;
}

function getOpenAtLoginSupport(): { supported: boolean; reason?: string } {
  if (platform !== 'darwin' && platform !== 'win32') {
    return { supported: false, reason: 'Launch at login is only supported on macOS and Windows.' };
  }
  if (!app.isPackaged) {
    return { supported: false, reason: 'Launch at login applies to packaged desktop releases.' };
  }
  return { supported: true };
}

function readOpenAtLogin(): boolean {
  if (!getOpenAtLoginSupport().supported) return false;
  try {
    return Boolean(app.getLoginItemSettings().openAtLogin);
  } catch {
    return false;
  }
}

function buildDesktopPreferencesSnapshot(): DesktopPreferencesSnapshot {
  const stored = desktopPrefs.get();
  const values = resolveDesktopPreferenceValues(stored, {
    openAtLogin: readOpenAtLogin(),
  });
  const loginSupport = getOpenAtLoginSupport();
  const descriptors: DesktopPreferenceDescriptor[] = [
    { key: 'confirmBeforeQuit', supported: true },
    {
      key: 'openAtLogin',
      supported: loginSupport.supported,
      ...(loginSupport.reason ? { reason: loginSupport.reason } : {}),
    },
    { key: 'autoCheckUpdates', supported: true },
    { key: 'hardwareAcceleration', supported: true, requiresRestart: true },
    { key: 'locale', supported: true },
    { key: 'lastDownloadDir', supported: true, picker: true },
  ];
  const pendingRestartKeys: DesktopPreferenceKey[] = [];
  if (values.hardwareAcceleration !== bootHardwareAcceleration) {
    pendingRestartKeys.push('hardwareAcceleration');
  }
  return {
    values,
    descriptors,
    platform,
    pendingRestartKeys,
  };
}

function emitPreferencesChanged(): void {
  registry.emit(HOST_CAPABILITIES.PREFERENCES, 'changed', buildDesktopPreferencesSnapshot());
}

function clearStartupLoadWatchdog(): void {
  if (startupLoadWatchdogTimer) {
    clearTimeout(startupLoadWatchdogTimer);
    startupLoadWatchdogTimer = null;
  }
}

function clearUnresponsiveTimer(): void {
  if (unresponsiveTimer) {
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
  }
}

function applyResolvedTheme(nextTheme: 'light' | 'dark'): void {
  const changed = nextTheme !== currentTheme;
  currentTheme = nextTheme;
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    try {
      win.setBackgroundColor(getDesktopWindowBackgroundColor(currentTheme));
      if (platform === 'win32') {
        win.setTitleBarOverlay(getWindowsTitleBarOverlay(currentTheme));
      }
    } catch {
      // Ignore background / overlay update failures on unsupported modes.
    }
    if (showingRetryPage) {
      void win.webContents
        .executeJavaScript(`window.__setDesktopTheme && window.__setDesktopTheme(${JSON.stringify(currentTheme)})`)
        .catch(() => {});
    } else {
      void syncEnvironmentBadge(win);
    }
  }
  if (changed) {
    registry.emit(HOST_CAPABILITIES.WINDOW, 'themeChanged', {
      theme: currentTheme,
      source: themePreference,
    });
  }
}

function showDesktopNotification(options: {
  title: string;
  body?: string;
  silent?: boolean;
  bounce?: boolean;
  whenUnfocusedOnly?: boolean;
  onClick?: () => void;
}): { delivered: boolean; bounced: boolean } {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const isFocused = Boolean(win?.isFocused());
  if (options.whenUnfocusedOnly && isFocused) {
    return { delivered: false, bounced: false };
  }

  let bounced = false;
  if (options.bounce !== false && platform === 'darwin' && !isFocused) {
    try {
      app.dock?.bounce('informational');
      bounced = true;
    } catch {
      // Ignore dock bounce errors.
    }
  }

  if (!Notification.isSupported()) {
    return { delivered: false, bounced };
  }
  try {
    const notification = new Notification({
      title: options.title,
      ...(options.body ? { body: options.body } : {}),
      ...(typeof options.silent === 'boolean' ? { silent: options.silent } : {}),
    });
    notification.on('click', () => {
      if (options.onClick) {
        options.onClick();
      } else {
        focusOrRestoreMainWindow();
      }
    });
    notification.show();
    return { delivered: true, bounced };
  } catch {
    return { delivered: false, bounced };
  }
}

async function installDownloadedUpdate(): Promise<{ ok: boolean; error?: string }> {
  const startedAt = Date.now();
  const result = await updater.installUpdateNow(async () => {
    quitConfirmed = true;
    shuttingDown = true;
    wakeLockManager.releaseAll();
    progressCoordinator.clearAll();
    authHandoff.cancelLogin();
    logger.markSessionEnded('install-update');
    sessionTracker.end();
  });
  const endedAt = Date.now();
  telemetry.record({
    category: 'updater.install',
    outcome: result.ok ? 'ok' : 'error',
    durationMs: endedAt - startedAt,
  });
  desktopSentry.addBreadcrumb({
    category: 'updater',
    message: result.ok ? 'Install update initiated' : 'Install update failed',
    level: result.ok ? 'info' : 'warning',
  });
  void desktopSentry.captureTransaction({
    name: 'desktop.updater.install',
    op: 'updater.install',
    startMs: startedAt,
    endMs: endedAt,
    status: result.ok ? 'ok' : 'internal_error',
    tags: { outcome: result.ok ? 'ok' : 'error' },
  });
  return result;
}

function getAllowedHistoryOrigins(): Set<string> {
  const active = signedConfig.getActiveConfig();
  return resolveAllowedStudioOrigins({
    channel: releaseChannel,
    studioUrl: resolveStudioUrl(),
    allowedOrigins: active.allowedOrigins,
    allowLocalDevLoopback,
  });
}

function getHistoryNavigationAvailability(): { canGoBack: boolean; canGoForward: boolean } {
  const win = mainWindow;
  if (!win || win.isDestroyed() || showingRetryPage || inWindowAuthFallbackActive) {
    return { canGoBack: false, canGoForward: false };
  }
  try {
    const history = win.webContents.navigationHistory;
    const activeIndex = history.getActiveIndex();
    const allowedOrigins = getAllowedHistoryOrigins();
    const prevEntry = activeIndex > 0 ? history.getEntryAtIndex(activeIndex - 1) : undefined;
    const nextEntry =
      activeIndex >= 0 && activeIndex + 1 < history.length()
        ? history.getEntryAtIndex(activeIndex + 1)
        : undefined;
    return {
      canGoBack: isSafeHistoryNavigationTarget(prevEntry?.url, allowedOrigins),
      canGoForward: isSafeHistoryNavigationTarget(nextEntry?.url, allowedOrigins),
    };
  } catch {
    return { canGoBack: false, canGoForward: false };
  }
}

function navigateMainWindowHistory(direction: 'back' | 'forward'): boolean {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return false;
  const availability = getHistoryNavigationAvailability();
  if (direction === 'back' && availability.canGoBack) {
    win.webContents.navigationHistory.goBack();
    return true;
  }
  if (direction === 'forward' && availability.canGoForward) {
    win.webContents.navigationHistory.goForward();
    return true;
  }
  return false;
}

function dispatchMenuAction(action: DesktopMenuAction): void {
  if (action === 'export-logs') {
    void exportLogsWithDialog();
    return;
  }
  if (action === 'reload-app' && mainWindow && !mainWindow.isDestroyed()) {
    void loadStudioIntoMainWindow();
    return;
  }
  if (action === 'check-updates') {
    manualUpdateCheckPending = true;
    void updater.checkForUpdates().then(state => {
      void maybePresentManualUpdateFeedback(state);
    });
  }
  focusOrRestoreMainWindow();
  if (rendererReady) {
    registry.emit(HOST_CAPABILITIES.WINDOW, 'menuAction', action);
  } else {
    queuePendingMenuAction(action);
  }
}

async function openExternalSafe(url: string): Promise<{ ok: boolean; error?: string }> {
  if (!isAllowedExternalUrl(url)) {
    return { ok: false, error: 'Unsupported external URL protocol' };
  }
  await shell.openExternal(url);
  return { ok: true };
}

async function exportLogsWithDialog(): Promise<DesktopDiagnosticExportResult> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = `openmotion-diagnostics-${stamp}.zip`;
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const saveOptions = {
      title: 'Export OpenDesign Diagnostic Logs',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    };
    const picked = parent
      ? await dialog.showSaveDialog(parent, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (picked.canceled || !picked.filePath) {
      return { ok: false, canceled: true };
    }
    const result = await createDesktopDiagnosticZip({
      appRoot: distDir,
      dataDir,
      logDir,
      outPath: picked.filePath,
    });
    logger.info('main', 'Exported diagnostic bundle', { entryCount: result.entryCount });
    return { ok: true, path: result.path, entryCount: result.entryCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('main', 'Failed to export diagnostics', { error: message });
    return { ok: false, error: message };
  }
}

async function openLogsFolder(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const err = await shell.openPath(logDir);
  if (err) {
    return { ok: false, error: err };
  }
  return { ok: true, path: logDir };
}

const bootOverlay = createBootOverlayController({
  distDir,
  getMainWindow: () => mainWindow,
  getCurrentTheme: () => currentTheme,
  isShuttingDown: () => shuttingDown,
});

function dismissBootOverlay(options: { immediate?: boolean } = {}): void {
  bootOverlay.dismiss(options);
}

function scheduleBootOverlayDismiss(delayMs = 200): void {
  bootOverlay.scheduleDismiss(delayMs);
}

function attachBootOverlay(win: BrowserWindow, onReady: () => void): void {
  bootOverlay.attach(win, onReady);
}

function revealMainWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) {
    win.show();
  }
  broadcastChromeState();
}

const reportedBridgeDenials = new Set<string>();

/**
 * A page that received the bridge but is refused by the guard means the shell and
 * the Studio origin disagree (a migrated origin, or an unexpected page in the main
 * window). Studio silently behaves like a browser tab then, so report it once.
 */
function reportBridgeDenied(error: { code: string; message: string }): void {
  if (reportedBridgeDenials.has(error.message) || reportedBridgeDenials.size >= 5) return;
  reportedBridgeDenials.add(error.message);
  logger.warn('main', 'Host bridge call denied', { code: error.code, message: error.message });
  void desktopSentry.captureMessage(`Host bridge call denied: ${error.code}`, 'warning', {
    area: 'bridge',
    tags: { deny_code: error.code },
    extra: { reason: error.message },
  });
}

const CONNECTIVITY_REFERENCE_URL = `${DEFAULT_SIGNED_CONFIG_BASE_URL}/${
  releaseChannel === 'stable' ? 'stable' : 'test'
}.json`;
let startupOutcomeRecorded = false;
let startupDidFinishLoadFallbackTimer: ReturnType<typeof setTimeout> | null = null;
const STARTUP_DID_FINISH_LOAD_FALLBACK_MS = 2_000;

function clearStartupDidFinishLoadFallback(): void {
  if (startupDidFinishLoadFallbackTimer) {
    clearTimeout(startupDidFinishLoadFallbackTimer);
    startupDidFinishLoadFallbackTimer = null;
  }
}

function recordStartupPerformanceTransaction(
  outcome: 'ok' | 'timeout' | 'network_error' | 'error',
  finishedAt: number,
  errorCode?: string,
  stage?: 'renderer_ready' | 'did_finish_load',
): void {
  const spans: Array<{
    op: string;
    description: string;
    startMs: number;
    endMs: number;
    status?: 'ok' | 'deadline_exceeded' | 'internal_error';
  }> = [];
  if (appReadyAt !== null) {
    spans.push({
      op: 'electron.ready',
      description: 'Electron app.whenReady',
      startMs: appStartupStartedAt,
      endMs: appReadyAt,
    });
  }
  if (appReadyAt !== null && windowCreatedAt !== null) {
    spans.push({
      op: 'window.create',
      description: 'Create main BrowserWindow',
      startMs: appReadyAt,
      endMs: windowCreatedAt,
    });
  }
  if (studioLoadStartedAt !== null) {
    if (domReadyAt !== null) {
      spans.push({
        op: 'studio.dom_ready',
        description: 'Studio DOM ready',
        startMs: studioLoadStartedAt,
        endMs: domReadyAt,
      });
    }
    if (didFinishLoadAt !== null) {
      spans.push({
        op: 'studio.did_finish_load',
        description: 'Studio did-finish-load',
        startMs: domReadyAt ?? studioLoadStartedAt,
        endMs: didFinishLoadAt,
      });
    }
    spans.push({
      op: 'studio.load',
      description: outcome === 'ok' ? 'Studio load to ready' : `Studio load failed (${errorCode ?? outcome})`,
      startMs: studioLoadStartedAt,
      endMs: finishedAt,
      status: outcome === 'ok' ? 'ok' : outcome === 'timeout' ? 'deadline_exceeded' : 'internal_error',
    });
  }
  const durationMs = Math.max(0, finishedAt - appStartupStartedAt);
  void desktopSentry.captureTransaction({
    name: 'desktop.startup',
    op: 'app.launch',
    startMs: appStartupStartedAt,
    endMs: finishedAt,
    status: outcome === 'ok' ? 'ok' : outcome === 'timeout' ? 'deadline_exceeded' : 'internal_error',
    tags: {
      outcome,
      ...(stage ? { startup_stage: stage } : {}),
      ...(errorCode ? { error_code: errorCode } : {}),
    },
    measurements: {
      app_cold_start: { value: durationMs, unit: 'millisecond' },
    },
    spans,
  });
}

function recordStartupSuccess(finishedAt: number, stage: 'renderer_ready' | 'did_finish_load'): void {
  clearStartupDidFinishLoadFallback();
  if (startupOutcomeRecorded) return;
  startupOutcomeRecorded = true;
  const durationMs = Math.max(0, finishedAt - appStartupStartedAt);
  telemetry.record({
    category: 'app.startup',
    outcome: 'ok',
    durationMs,
  });
  desktopSentry.addBreadcrumb({
    category: 'lifecycle',
    message: stage === 'renderer_ready' ? 'Renderer ready' : 'Studio finished loading',
    data: { startupDurationMs: durationMs, stage },
  });
  recordStartupPerformanceTransaction('ok', finishedAt, undefined, stage);
  void desktopSentry.flushOutbox();
}

/**
 * Reports a failed Studio load. The retry page is shown exactly when in-page
 * reporting cannot run, so this is the only signal such a failure produces.
 */
function reportLoadFailure(info: { code?: string; detail?: string; incidentId: string }): void {
  clearStartupDidFinishLoadFallback();
  const code = info.code ?? 'UNKNOWN';
  const failure = classifyLoadFailure(info.code);
  const nowMs = Date.now();
  logger.error('main', 'Studio load failed', { code, incidentId: info.incidentId });
  desktopSentry.addBreadcrumb({
    category: 'navigation',
    level: 'error',
    message: `Studio load failed: ${code}`,
    data: { incidentId: info.incidentId },
  });
  if (!startupOutcomeRecorded) {
    startupOutcomeRecorded = true;
    telemetry.record({
      category: 'app.startup',
      outcome: failure.outcome,
      durationMs: nowMs - appStartupStartedAt,
      errorCode: code,
    });
    recordStartupPerformanceTransaction(failure.outcome, nowMs, code);
  }
  void (async () => {
    const connectivity =
      failure.network && app.isReady()
        ? await probeConnectivity(CONNECTIVITY_REFERENCE_URL, (url, init) => net.fetch(url, init))
        : 'not_checked';
    // An offline machine is the user's network, not a product fault: keep it out of error alerts.
    await desktopSentry.captureMessage(
      `Studio load failed: ${code}`,
      connectivity === 'offline' ? 'warning' : 'error',
      {
        area: 'load',
        tags: { load_failure_code: code, connectivity, incident_id: info.incidentId },
        extra: { detail: info.detail },
      },
    );
  })();
}

async function showRetryPage(info: {
  badge?: string;
  title?: string;
  code?: string;
  message?: string;
  detail?: string;
  force?: boolean;
  /** Set by a caller that already reported this failure under the same reference. */
  incidentId?: string;
}): Promise<void> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (showingRetryPage && !info.force) return;
  const incidentId = info.incidentId ?? createIncidentId();
  if (!info.incidentId) reportLoadFailure({ code: info.code, detail: info.detail, incidentId });
  clearStartupLoadWatchdog();
  clearUnresponsiveTimer();
  dismissBootOverlay({ immediate: true });
  showingRetryPage = true;
  inWindowAuthFallbackActive = false;
  rendererReady = false;
  const query: Record<string, string> = {
    theme: currentTheme,
    locale: getEffectiveAppLocale(),
  };
  if (platform === 'linux' && linuxCustomTitleBar) {
    query.customWindowControls = '1';
  }
  if (envSwitcherEnabled) {
    const envDesc = resolveCurrentEnvironmentDescription();
    query.canSwitchEnv = '1';
    if (envDesc.isCustomOverride) {
      query.canResetEnv = '1';
    }
  }
  if (info.badge) query.badge = info.badge;
  if (info.title) query.title = info.title;
  if (info.code) query.code = info.code;
  if (info.message) query.message = info.message;
  if (info.detail) query.detail = info.detail;
  query.incident = incidentId;
  await win.loadFile(path.join(distDir, 'retry.html'), { query });
  revealMainWindow();
  refreshDesktopMenus();
}

async function loadStudioIntoMainWindow(targetPath?: string): Promise<void> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  clearStartupLoadWatchdog();
  clearUnresponsiveTimer();
  showingRetryPage = false;
  inWindowAuthFallbackActive = false;
  rendererReady = false;
  const baseTargetUrl = resolveStudioUrl();
  let targetUrl = baseTargetUrl;
  if (targetPath && targetPath.startsWith('/') && !targetPath.startsWith('//') && !targetPath.includes('\\')) {
    try {
      const expectedOrigin = new URL(baseTargetUrl).origin;
      const resolved = new URL(targetPath, baseTargetUrl);
      if (resolved.origin === expectedOrigin) {
        targetUrl = resolved.toString();
      }
    } catch {
      targetUrl = baseTargetUrl;
    }
  }
  logger.info('main', 'Loading cloud Studio URL', { url: targetUrl });
  if (studioLoadStartedAt === null) {
    studioLoadStartedAt = Date.now();
  }
  desktopSentry.addBreadcrumb({
    category: 'navigation',
    message: 'Loading Studio URL',
    data: { url: sanitizeUrlForBreadcrumb(targetUrl) },
  });

  startupLoadWatchdogTimer = setTimeout(() => {
    startupLoadWatchdogTimer = null;
    if (shuttingDown || !mainWindow || mainWindow.isDestroyed() || showingRetryPage || rendererReady) {
      return;
    }
    const loadedUrl = mainWindow.webContents.getURL();
    if (loadedUrl && !loadedUrl.startsWith('file://') && !mainWindow.webContents.isLoadingMainFrame()) {
      return;
    }
    logger.warn('main', 'Cloud Studio load timed out', { url: targetUrl, timeoutMs: STARTUP_LOAD_TIMEOUT_MS });
    const zh = isZhAppLocale();
    void showRetryPage({
      badge: zh ? '连接超时' : 'Connection timed out',
      title: zh ? '连接 OpenDesign 超时' : 'Taking longer than usual to connect',
      code: 'NET_TIMEOUT',
      message: zh
        ? '暂时未能连上 OpenDesign Cloud，请检查网络或代理设置后重试。'
        : 'OpenDesign Cloud did not respond in time. Check your network or proxy settings and retry.',
      detail: `${targetUrl} (${Math.round(STARTUP_LOAD_TIMEOUT_MS / 1000)}s)`,
      force: true,
    });
  }, STARTUP_LOAD_TIMEOUT_MS);

  try {
    await win.loadURL(targetUrl);
  } catch (error) {
    clearStartupLoadWatchdog();
    // If shutting down, window was destroyed, or `did-fail-load` already transitioned to retry.html
    // (which aborts the superseded `loadURL` promise with ERR_ABORTED -3), exit cleanly.
    if (shuttingDown || win.isDestroyed() || showingRetryPage) return;
    const message = error instanceof Error ? error.message : String(error);
    logger.error('main', 'Failed to load cloud Studio URL', { error: message });
    await showRetryPage({
      code: 'LOAD_FAILED',
      message: 'Could not reach OpenDesign Cloud. Check your network connection and try again.',
      detail: message,
    });
  }
}

const sessionDownloads = createSessionDownloadController({
  desktopPrefs,
  wakeLockManager,
  progressCoordinator,
  isZhAppLocale,
  emitPreferencesChanged,
  focusOrRestoreMainWindow,
  showDesktopNotification,
});

const manualUpdateFeedback = createManualUpdateFeedbackPresenter({
  updater,
  getMainWindow: () => mainWindow,
  getEffectiveAppLocale,
  isShuttingDown: () => shuttingDown,
  isManualUpdateCheckPending: () => manualUpdateCheckPending,
  setManualUpdateCheckPending: pending => {
    manualUpdateCheckPending = pending;
  },
  installDownloadedUpdate,
});

const envController = createDesktopEnvironmentController({
  distDir,
  platform,
  releaseChannel,
  envSwitcherEnabled,
  envValidationOptions,
  envStore,
  authHandoff,
  registry,
  logger,
  wakeLockManager,
  progressCoordinator,
  getMainWindow: () => mainWindow,
  createMainWindow,
  getCurrentTheme: () => currentTheme,
  getEffectiveAppLocale,
  isZhAppLocale,
  isShuttingDown: () => shuttingDown,
  getActiveWindowPartition: () => activeWindowPartition,
  setSwitchingMainWindow: switching => {
    switchingMainWindow = switching;
  },
  clearCliStudioUrlOverride: () => {
    cliStudioUrlOverride = undefined;
  },
  setInWindowAuthFallbackActive: active => {
    inWindowAuthFallbackActive = active;
  },
  resolveBaseDefaultStudioUrl,
  resolveStudioUrl,
  resolveStudioOrigin,
  resolveCurrentEnvironmentDescription,
  resolveCurrentSessionPartition,
  clearStartupLoadWatchdog,
  clearUnresponsiveTimer,
  flushMainWindowState,
  focusOrRestoreMainWindow,
  refreshDesktopMenus,
  loadStudioIntoMainWindow,
  showDesktopNotification,
});

function registerCapabilities(): void {
  registerDesktopCapabilities({
    registry,
    updater,
    authHandoff,
    signedConfig,
    telemetry,
    desktopSentry,
    desktopPrefs,
    atomsRuntime,
    progressCoordinator,
    wakeLockManager,
    getMainWindow: () => mainWindow,
    currentChromeState,
    setThemePreference: theme => {
      themePreference = theme;
    },
    applyResolvedTheme,
    openExternalSafe,
    onRendererReady: () => {
      clearStartupLoadWatchdog();
      recordStartupSuccess(Date.now(), 'renderer_ready');
      // Studio is up, so the network path works: deliver anything still queued.
      void desktopSentry.flushOutbox();
      rendererReady = true;
      dismissBootOverlay();
      revealMainWindow();
      const queued = pendingMenuActions;
      pendingMenuActions = [];
      for (const action of queued) {
        registry.emit(HOST_CAPABILITIES.WINDOW, "menuAction", action);
      }
    },
    loadStudioIntoMainWindow,
    showDesktopNotification,
    installDownloadedUpdate,
    buildRuntimeInfo,
    exportLogsWithDialog,
    openLogsFolder,
    setInWindowAuthFallbackActive: active => {
      inWindowAuthFallbackActive = active;
    },
    startDesktopSignIn,
    openInWindowLoginFlow,
    maybeReloadMainWindowForSignedConfigChange,
    onSignedConfigApplied: () => {
      syncUpdaterPolicyFromSignedConfig({ triggerCheckIfMandatory: true });
    },
    buildDesktopPreferencesSnapshot,
    refreshDesktopMenus,
    emitPreferencesChanged,
    clearStartupUpdateCheckTimer: () => {
      if (startupUpdateCheckTimer) {
        clearTimeout(startupUpdateCheckTimer);
        startupUpdateCheckTimer = null;
      }
    },
    getOpenAtLoginSupport,
    isZhAppLocale,
    markQuitConfirmed: () => {
      quitConfirmed = true;
    },
  });
}

function registerIpc(): void {
  registerDesktopIpc({
    distDir,
    releaseChannel,
    envSwitcherEnabled,
    registry,
    updater,
    authHandoff,
    envController,
    getMainWindow: () => mainWindow,
    getPrivilegedGuardOptions,
    onPrivilegedIpcDenied: reportBridgeDenied,
    buildRuntimeInfo,
    resolveStudioUrl,
    loadStudioIntoMainWindow,
    exportLogsWithDialog,
    setDomFullscreen: active => {
      domFullscreen = active;
    },
    broadcastChromeState,
    refreshDesktopMenus,
    isManualUpdateCheckPending: () => manualUpdateCheckPending,
    setManualUpdateCheckPending: pending => {
      manualUpdateCheckPending = pending;
    },
    maybePresentManualUpdateFeedback,
    getLastNotifiedDownloadedVersion: () => lastNotifiedDownloadedVersion,
    setLastNotifiedDownloadedVersion: version => {
      lastNotifiedDownloadedVersion = version;
    },
    isZhAppLocale,
    focusOrRestoreMainWindow,
    showDesktopNotification,
  });
}

async function maybePresentManualUpdateFeedback(
  state: ReturnType<DesktopUpdaterController["getState"]>,
): Promise<void> {
  await manualUpdateFeedback.maybePresent(state);
}

function attachSessionDownloadHandler(win: BrowserWindow): void {
  sessionDownloads.attach(win);
}

function captureMainWindowState(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  if (!win.isMaximized() && !win.isMinimized()) {
    lastNormalWindowBounds = win.getNormalBounds();
  }
}

function flushMainWindowState(): void {
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
  }
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  captureMainWindowState();
  const bounds = lastNormalWindowBounds ?? win.getNormalBounds();
  writeWindowState(windowStatePath, {
    version: 1,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: win.isMaximized(),
  });
}

function scheduleSaveMainWindowState(): void {
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
  }
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    flushMainWindowState();
  }, 250);
}

function resolveMainWindowTitle(): string {
  return envController.resolveMainWindowTitle();
}

function buildEnvironmentSwitcherPayload() {
  return envController.buildSwitcherPayload();
}

function closeEnvironmentSwitcherWindow(): void {
  envController.closeSwitcherWindow();
}

function openEnvironmentSwitcherWindow(): void {
  envController.openSwitcherWindow();
}

async function syncEnvironmentBadge(win: BrowserWindow): Promise<void> {
  await envController.syncEnvironmentBadge(win);
}

async function switchDesktopEnvironment(
  nextUrl: string | null,
  targetPath?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return envController.switchEnvironment(nextUrl, targetPath);
}

async function clearCurrentEnvironmentDataAndReload(): Promise<void> {
  await envController.clearCurrentDataAndReload();
}

function copyEnvironmentDiagnostics(): void {
  envController.copyDiagnostics();
}

async function handleDeepLinkOpen(params: Readonly<Record<string, string>>): Promise<void> {
  await envController.handleDeepLinkOpen(params);
}

function createMainWindow(): BrowserWindow {
  const preloadPath = path.join(distDir, 'preload.cjs');
  const displays = screen.getAllDisplays().map(display => display.workArea);
  const restored = resolveRestoredWindowBounds(
    readWindowState(windowStatePath),
    displays,
    DEFAULT_MAIN_WINDOW_BOUNDS,
  );
  shouldRestoreMaximized = restored.maximized;
  const partition = resolveCurrentSessionPartition();
  activeWindowPartition = partition;

  const win = new BrowserWindow(
    buildMainWindowOptions({
      platform,
      theme: currentTheme,
      linuxCustomTitleBar,
      preloadPath,
      iconPath: resolveIconPath(),
      bounds: restored.bounds,
      partition,
      title: resolveMainWindowTitle(),
    }),
  );
  mainWindow = win;
  lastNormalWindowBounds = win.getNormalBounds();

  attachNativeContextMenu(win.webContents, {
    platform,
    getLocale: () => getEffectiveAppLocale(),
    openExternal: openExternalSafe,
    writeClipboardText: text => clipboard.writeText(text),
    popupTemplate: template => {
      Menu.buildFromTemplate(template).popup({ window: win });
    },
  });

  attachSessionDownloadHandler(win);

  const policyWebContents: PolicyWebContentsLike = {
    on: (event, listener) => {
      win.webContents.on(event as 'will-navigate', listener as (event: Electron.Event, url: string) => void);
    },
    setWindowOpenHandler: handler => {
      win.webContents.setWindowOpenHandler(handler);
    },
  };

  const maybeResetAuthFallback = (url: string) => {
    if (!inWindowAuthFallbackActive) return;
    try {
      const parsed = new URL(url);
      if (parsed.origin === resolveStudioOrigin() && parsed.pathname !== '/auth' && !parsed.pathname.startsWith('/auth/')) {
        inWindowAuthFallbackActive = false;
      }
    } catch {
      // Ignore unparseable URLs.
    }
  };

  // Intercept direct same-origin /auth/login navigations (e.g. legacy Studio web builds)
  // so sign-in routes through K3 browser PKCE handoff when available, or controlled
  // in-window fallback when the target backend has not mounted /auth/desktop/start yet.
  win.webContents.on('will-navigate', (event, url) => {
    if (showingRetryPage && url.startsWith('file://') && url.includes('retry.html')) {
      event.preventDefault();
      void loadStudioIntoMainWindow();
      return;
    }
    if (!inWindowAuthFallbackActive) {
      const authNav = parseStudioAuthNavigationUrl(url, resolveStudioOrigin());
      if (authNav) {
        event.preventDefault();
        void startDesktopSignIn(authNav).catch(error => {
          logger.error('main', 'Desktop sign-in navigation intercept failed', {
            url,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  });

  attachWindowNavigationPolicies(policyWebContents, {
    getConfig: getWindowPolicyConfig,
    openExternal: async url => {
      await openExternalSafe(url);
    },
    onDecision: (kind, url, decision) => {
      if (inWindowAuthFallbackActive && decision.action === 'allow' && decision.reason === 'same-origin-studio') {
        maybeResetAuthFallback(url);
      }
      if (decision.action === 'deny' && !decision.openExternal) {
        logger.warn('main', `Blocked ${kind}`, { url, reason: decision.reason });
      }
    },
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // Ignore subframe failures and ERR_ABORTED
    if (validatedURL.startsWith('file://')) return;
    inWindowAuthFallbackActive = false;
    logger.error('main', 'Cloud Studio load failed', { errorCode, errorDescription, validatedURL });
    void showRetryPage({
      code: `NET_${errorCode}`,
      message: 'OpenDesign Cloud could not be reached. Check your connection and try again.',
      detail: `${errorDescription} (${validatedURL})`,
    });
  });
  win.webContents.on('did-navigate', (_event, url) => {
    injectedChromeCssKey = null;
    clearUnresponsiveTimer();
    wakeLockManager.releasePrefix('task:');
    progressCoordinator.clearTasks();
    finishLiveResizing();
    maybeResetAuthFallback(url);
    void syncWindowChromeCss();
    refreshDesktopMenus();
    desktopSentry.addBreadcrumb({
      category: 'navigation',
      message: 'Window navigated',
      data: { url: sanitizeUrlForBreadcrumb(url) },
    });
  });
  win.webContents.on('dom-ready', () => {
    if (domReadyAt === null && !showingRetryPage) {
      domReadyAt = Date.now();
    }
    clearStartupLoadWatchdog();
    void syncWindowChromeCss();
  });
  win.webContents.on('zoom-changed', (_event, zoomDirection) => {
    adjustMainWindowZoom(zoomDirection === 'in' ? 'in' : 'out');
  });
  win.webContents.on('did-finish-load', () => {
    if (didFinishLoadAt === null && !showingRetryPage) {
      didFinishLoadAt = Date.now();
    }
    clearStartupLoadWatchdog();
    refreshDesktopMenus();
    void syncEnvironmentBadge(win);
    if (!showingRetryPage) {
      scheduleBootOverlayDismiss(220);
      if (!startupOutcomeRecorded && !startupDidFinishLoadFallbackTimer) {
        const finishedAt = didFinishLoadAt ?? Date.now();
        startupDidFinishLoadFallbackTimer = setTimeout(() => {
          startupDidFinishLoadFallbackTimer = null;
          if (!shuttingDown && !showingRetryPage && !startupOutcomeRecorded) {
            recordStartupSuccess(finishedAt, 'did_finish_load');
          }
        }, STARTUP_DID_FINISH_LOAD_FALLBACK_MS);
      }
    }
  });
  win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) {
      maybeResetAuthFallback(url);
      refreshDesktopMenus();
    }
  });

  const revealOnceReady = () => {
    clearTimeout(initialRevealTimer);
    if (win.isDestroyed()) return;
    if (shouldRestoreMaximized) {
      shouldRestoreMaximized = false;
      win.maximize();
    }
    revealMainWindow();
  };

  const initialRevealTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      revealOnceReady();
    }
  }, 180);

  attachBootOverlay(win, revealOnceReady);

  win.once('ready-to-show', () => {
    revealOnceReady();
  });

  win.on('close', event => {
    flushMainWindowState();
    if (platform === 'darwin' && !shuttingDown) {
      event.preventDefault();
      if (win.isFullScreen()) {
        win.once('leave-full-screen', () => {
          if (!win.isDestroyed() && !shuttingDown) win.hide();
        });
        win.setFullScreen(false);
      } else {
        win.hide();
      }
    }
  });

  win.on('closed', () => {
    clearTimeout(initialRevealTimer);
    dismissBootOverlay({ immediate: true });
    clearStartupLoadWatchdog();
    clearUnresponsiveTimer();
    wakeLockManager.releasePrefix('task:');
    progressCoordinator.clearTasks();
    finishLiveResizing();
    if (windowStateSaveTimer) {
      clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = null;
    }
    if (mainWindow === win) {
      mainWindow = null;
      injectedChromeCssKey = null;
    }
  });
  win.on('app-command', (_event, cmd) => {
    if (cmd === 'browser-backward') {
      navigateMainWindowHistory('back');
    } else if (cmd === 'browser-forward') {
      navigateMainWindowHistory('forward');
    }
  });
  win.on('swipe', (_event, direction) => {
    if (direction === 'left') {
      navigateMainWindowHistory('back');
    } else if (direction === 'right') {
      navigateMainWindowHistory('forward');
    }
  });
  win.on('unresponsive', () => {
    logger.warn('renderer', 'Main window became unresponsive');
    desktopSentry.addBreadcrumb({
      category: 'window',
      level: 'warning',
      message: 'Main window became unresponsive',
    });
    if (unresponsiveTimer || unresponsiveDialogOpen || shuttingDown) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      if (shuttingDown || unresponsiveDialogOpen || win.isDestroyed()) return;
      unresponsiveDialogOpen = true;
      const zh = isZhAppLocale();
      void dialog
        .showMessageBox(win, {
          type: 'warning',
          title: zh ? '页面暂时无响应' : 'Workspace Unresponsive',
          message: zh
            ? 'OpenDesign 页面暂时没有响应，你可以继续等待或重新加载工作区。'
            : 'OpenDesign is not responding right now. You can keep waiting or reload the workspace.',
          buttons: zh ? ['继续等待', '重新加载'] : ['Wait', 'Reload Workspace'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        .then(({ response }) => {
          if (response === 1 && !win.isDestroyed()) {
            void loadStudioIntoMainWindow();
          }
        })
        .catch(() => {})
        .finally(() => {
          unresponsiveDialogOpen = false;
        });
    }, UNRESPONSIVE_PROMPT_DELAY_MS);
  });
  win.on('responsive', () => {
    clearUnresponsiveTimer();
    desktopSentry.addBreadcrumb({
      category: 'window',
      message: 'Main window became responsive again',
    });
  });
  win.on('will-resize', () => {
    markLiveResizing();
  });
  win.on('move', () => {
    scheduleSaveMainWindowState();
  });
  win.on('moved', () => {
    scheduleSaveMainWindowState();
  });
  win.on('resize', () => {
    markLiveResizing();
    scheduleSaveMainWindowState();
  });
  win.on('resized', () => {
    finishLiveResizing();
    scheduleSaveMainWindowState();
  });
  win.on('blur', () => {
    finishLiveResizing();
  });
  win.on('hide', () => {
    finishLiveResizing();
    registry.emit(HOST_CAPABILITIES.WINDOW, 'visibility', { visible: false });
  });
  win.on('show', () => {
    registry.emit(HOST_CAPABILITIES.WINDOW, 'visibility', { visible: true });
  });
  win.on('enter-full-screen', broadcastChromeState);
  win.on('leave-full-screen', broadcastChromeState);
  win.on('maximize', () => {
    broadcastChromeState();
    scheduleSaveMainWindowState();
  });
  win.on('unmaximize', () => {
    broadcastChromeState();
    scheduleSaveMainWindowState();
  });
  win.on('focus', () => {
    registry.emit(HOST_CAPABILITIES.WINDOW, 'focus', { focused: true });
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    clearStartupLoadWatchdog();
    clearUnresponsiveTimer();
    wakeLockManager.releasePrefix('task:');
    progressCoordinator.clearTasks();
    logger.error('renderer', 'Renderer process gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
    logger.writeCrashMarker('renderer-gone', details);
    if (details.reason !== 'clean-exit' && details.reason !== 'killed') sessionTracker.noteCrash();
    const incidentId = createIncidentId();
    void desktopSentry.captureMessage(`Renderer process gone: ${details.reason}`, 'fatal', {
      area: 'renderer',
      tags: { incident_id: incidentId },
      extra: { reason: details.reason, exitCode: details.exitCode },
    });
    if (shuttingDown || win.isDestroyed()) return;
    const decision = crashGuard.recordExit(details.reason);
    if (decision.recover) {
      const retryInfo = buildRendererCrashRetryInfo(decision, details, getEffectiveAppLocale());
      void showRetryPage({ ...retryInfo, force: true, incidentId });
    }
  });

  if (windowCreatedAt === null) {
    windowCreatedAt = Date.now();
  }
  desktopSentry.addBreadcrumb({
    category: 'lifecycle',
    message: 'Main window created',
  });
  return win;
}

const STARTUP_UPDATE_CHECK_DELAY_MS = 8_000;
let startupUpdateCheckTimer: ReturnType<typeof setTimeout> | null = null;

function preconnectStudioOrigin(): void {
  try {
    const origin = resolveStudioOrigin();
    if (origin.startsWith('https://') || origin.startsWith('http://')) {
      session.defaultSession.preconnect({ url: origin, numSockets: 4 });
    }
  } catch {
    // Ignore preconnect failures on restricted or offline environments.
  }
}

function scheduleStartupUpdateCheck(): void {
  if (!app.isPackaged) return;
  if (updater.getState().mandatory) {
    if (!shuttingDown) {
      void updater.checkForUpdates().catch(() => {});
    }
    return;
  }
  if (startupUpdateCheckTimer || !isAutoCheckUpdatesEnabled()) return;
  startupUpdateCheckTimer = setTimeout(() => {
    startupUpdateCheckTimer = null;
    if (shuttingDown || (!isAutoCheckUpdatesEnabled() && !updater.getState().mandatory)) return;
    void updater.checkForUpdates().catch(() => {});
  }, STARTUP_UPDATE_CHECK_DELAY_MS);
}

let desktopMenusInitialized = false;

function refreshDesktopMenus(force = false): void {
  if (!desktopMenusInitialized || shuttingDown) return;
  const appLocale = getEffectiveAppLocale();
  const includeDevItems = !app.isPackaged || process.env.OPENMOTION_DESKTOP_DEVTOOLS === '1';
  const updateState = updater.getState();
  const updaterPresentation = resolveUpdaterMenuPresentation(updateState, appLocale);
  const confirmBeforeQuit = isConfirmBeforeQuitEnabled();
  const historyNav = getHistoryNavigationAvailability();
  const envPayload = envSwitcherEnabled ? buildEnvironmentSwitcherPayload() : null;
  const signature = [
    appLocale,
    includeDevItems ? '1' : '0',
    updaterPresentation.label,
    updaterPresentation.action,
    updaterPresentation.enabled ? '1' : '0',
    confirmBeforeQuit ? '1' : '0',
    historyNav.canGoBack ? '1' : '0',
    historyNav.canGoForward ? '1' : '0',
    envPayload ? `${envPayload.active.url}:${envPayload.recent.map(r => r.url).join(',')}` : '',
  ].join('|');
  if (!force && signature === lastMenuStateSignature) return;
  lastMenuStateSignature = signature;

  if (platform === 'darwin') {
    app.dock?.setMenu(
      Menu.buildFromTemplate(
        buildDesktopDockMenuTemplate({
          locale: appLocale,
          updateState,
          onAction: dispatchMenuAction,
          onInstallUpdate: () => {
            void installDownloadedUpdate();
          },
          onFocusMainWindow: focusOrRestoreMainWindow,
        }),
      ),
    );
  }

  const template = buildDesktopMenuTemplate({
    platform,
    appVersion: app.getVersion(),
    locale: appLocale,
    includeDevItems,
    updateState,
    confirmBeforeQuit,
    canGoBack: historyNav.canGoBack,
    canGoForward: historyNav.canGoForward,
    ...(envPayload
      ? {
          environment: {
            activeLabel: envPayload.active.label,
            activeUrl: envPayload.active.url,
            isCustomOverride: envPayload.active.isCustomOverride,
            presets: envPayload.presets.map(preset => ({
              label: preset.label,
              url: preset.url,
              active: preset.origin === envPayload.active.origin,
            })),
            recent: envPayload.recent.map(item => ({
              label: item.label,
              url: item.url,
              active: item.origin === envPayload.active.origin,
            })),
            onSelectUrl: url => {
              void switchDesktopEnvironment(url);
            },
            onOpenSwitcher: () => {
              openEnvironmentSwitcherWindow();
            },
            onResetDefault: () => {
              void switchDesktopEnvironment(null);
            },
            onClearEnvironmentData: () => {
              void clearCurrentEnvironmentDataAndReload();
            },
            onCopyEnvironmentInfo: () => {
              copyEnvironmentDiagnostics();
            },
          },
        }
      : {}),
    onAction: dispatchMenuAction,
    onOpenUrl: url => {
      void openExternalSafe(url);
    },
    onOpenLogsFolder: () => {
      void openLogsFolder();
    },
    onInstallUpdate: () => {
      void installDownloadedUpdate();
    },
    onNavigateBack: () => {
      navigateMainWindowHistory('back');
    },
    onNavigateForward: () => {
      navigateMainWindowHistory('forward');
    },
    onToggleConfirmBeforeQuit: enabled => {
      desktopPrefs.update({ confirmBeforeQuit: enabled });
      refreshDesktopMenus(true);
      emitPreferencesChanged();
    },
    onZoomChange: direction => {
      adjustMainWindowZoom(direction);
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupDesktopMenusAndAbout(): void {
  if (desktopMenusInitialized) return;
  desktopMenusInitialized = true;

  if (platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: DESKTOP_PRODUCT_NAME,
      applicationVersion: app.getVersion(),
      version: releaseChannel,
      copyright: 'Copyright © OpenDesign Contributors',
      ...(resolveIconPath() ? { iconPath: resolveIconPath() } : {}),
    });
  }

  refreshDesktopMenus(true);
}

function refreshSignedConfigInBackground(): void {
  void signedConfig
    .fetchAndApply()
    .then(result => {
      if (result.applied && !result.unchanged) {
        syncUpdaterPolicyFromSignedConfig({ triggerCheckIfMandatory: true });
        registry.emit(HOST_CAPABILITIES.SIGNED_CONFIG, 'updated', signedConfig.getStatus());
        maybeReloadMainWindowForSignedConfigChange();
      }
    })
    .catch(() => {});
}

async function bootDesktop(): Promise<void> {
  // Warm DNS/TCP/TLS sockets before constructing the window and initiating loadURL.
  preconnectStudioOrigin();

  // Single-window startup (macOS HIG): open the restored main window directly without
  // popping up a separate splash window that jumps size/position on handoff.
  // Signed config refreshes asynchronously in the background so cold start never stalls.
  refreshSignedConfigInBackground();

  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
  const loadPromise = loadStudioIntoMainWindow();
  setImmediate(() => {
    if (!shuttingDown) setupDesktopMenusAndAbout();
  });
  await loadPromise;

  scheduleStartupUpdateCheck();

  if (!signedConfigRefreshTimer) {
    signedConfigRefreshTimer = setInterval(() => {
      refreshSignedConfigInBackground();
    }, 30 * 60 * 1000);
  }
}

process.on('uncaughtException', error => {
  logger.error('main', 'Uncaught exception', { message: error.message, stack: error.stack });
  logger.writeCrashMarker('uncaught-exception', error);
  void desktopSentry.captureException(error, { area: 'uncaughtException' });
});

process.on('unhandledRejection', reason => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.error('main', 'Unhandled rejection', { message });
  logger.writeCrashMarker('unhandled-rejection', reason);
  void desktopSentry.captureException(reason, { area: 'unhandledRejection' });
});

app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit' || details.reason === 'killed') return;
  logger.error('main', 'Child process gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
  });
  void desktopSentry.captureMessage(`Child process gone: ${details.type} (${details.reason})`, 'error', {
    area: 'child-process',
    tags: { process_type: details.type, exit_reason: details.reason },
    extra: { exitCode: details.exitCode, name: details.name, serviceName: details.serviceName },
  });
});

app.on('open-url', (event, rawUrl) => {
  event.preventDefault();
  protocolRouter.handleUrl(rawUrl);
});

app.on('second-instance', (_event, argv) => {
  const deepLink = extractDeepLinkFromArgv(argv);
  if (deepLink) {
    protocolRouter.handleUrl(deepLink);
  } else {
    focusOrRestoreMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (switchingMainWindow) return;
  if (platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (!mainWindow && app.isReady()) {
    void bootDesktop();
  } else {
    focusOrRestoreMainWindow();
  }
});

async function promptQuitWithConfirmation(): Promise<void> {
  if (quitPromptOpen || shuttingDown) return;
  quitPromptOpen = true;
  closeEnvironmentSwitcherWindow();
  try {
    const zh = isZhAppLocale();
    const options = {
      type: 'question' as const,
      title: zh ? '退出 OpenDesign' : 'Quit OpenDesign',
      message: zh ? '确认退出 OpenDesign 吗？' : 'Are you sure you want to quit OpenDesign?',
      buttons: zh ? ['取消', '退出'] : ['Cancel', 'Quit'],
      defaultId: 1,
      cancelId: 0,
      checkboxLabel: zh ? '下次不再提示' : "Don't ask me again",
      checkboxChecked: false,
      noLink: true,
    };
    const { response, checkboxChecked } = await dialog.showMessageBox(options);
    if (response === 1) {
      if (checkboxChecked) {
        desktopPrefs.update({ confirmBeforeQuit: false });
        refreshDesktopMenus(true);
        emitPreferencesChanged();
      }
      quitConfirmed = true;
      shuttingDown = true;
      app.quit();
    }
  } finally {
    quitPromptOpen = false;
  }
}

app.on('before-quit', event => {
  if (
    !quitConfirmed &&
    !shuttingDown &&
    isConfirmBeforeQuitEnabled() &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.isVisible()
  ) {
    event.preventDefault();
    void promptQuitWithConfirmation();
    return;
  }
  shuttingDown = true;
  closeEnvironmentSwitcherWindow();
  dismissBootOverlay({ immediate: true });
  clearStartupLoadWatchdog();
  clearStartupDidFinishLoadFallback();
  clearUnresponsiveTimer();
  wakeLockManager.releaseAll();
  progressCoordinator.clearAll();
  flushMainWindowState();
  authHandoff.cancelLogin();
  if (startupUpdateCheckTimer) {
    clearTimeout(startupUpdateCheckTimer);
    startupUpdateCheckTimer = null;
  }
  if (signedConfigRefreshTimer) {
    clearInterval(signedConfigRefreshTimer);
    signedConfigRefreshTimer = null;
  }
  logger.markSessionEnded('quit');
  sessionTracker.end();
});

nativeTheme.on('updated', () => {
  if (themePreference !== 'system') return;
  const nextTheme: 'light' | 'dark' = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  applyResolvedTheme(nextTheme);
});

void app.whenReady().then(async () => {
  appReadyAt = Date.now();
  desktopSentry.addBreadcrumb({
    category: 'lifecycle',
    message: 'Electron app ready',
    data: { readyMs: appReadyAt - appStartupStartedAt },
  });
  preconnectStudioOrigin();
  registerDesktopProtocolClient(app);
  registerCapabilities();
  registerIpc();

  const initialDeepLink = extractDeepLinkFromArgv(process.argv);
  await bootDesktop();
  if (initialDeepLink) {
    protocolRouter.handleUrl(initialDeepLink);
  }
});
