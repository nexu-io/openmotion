import {
  DEFAULT_STUDIO_URLS,
  isUrlInAllowedDomainScope,
} from '../../shared/desktop-builtin-rules.ts';
import {
  hostErr,
  type HostInvokeFailure,
  type HostReleaseChannel,
} from '../../shared/desktop-contract.ts';

export const HOST_IPC_CHANNELS = {
  INFO: 'openmotion:host:info',
  CAPABILITIES: 'openmotion:host:capabilities',
  INVOKE: 'openmotion:host:invoke',
  EVENT: 'openmotion:host:event',
  DOM_FULLSCREEN: 'openmotion:dom-fullscreen',
  SPLASH_RETRY: 'openmotion:splash-retry',
  SPLASH_EXPORT_DIAGNOSTICS: 'openmotion:splash-export-diagnostics',
  SPLASH_WINDOW_CONTROL: 'openmotion:splash-window-control',
  SPLASH_RESET_ENV: 'openmotion:splash-reset-env',
  SPLASH_OPEN_ENV_SWITCHER: 'openmotion:splash-open-env-switcher',
  ENV_SWITCHER_GET_STATE: 'openmotion:env-switcher:get-state',
  ENV_SWITCHER_SELECT: 'openmotion:env-switcher:select',
  ENV_SWITCHER_RESET: 'openmotion:env-switcher:reset',
  ENV_SWITCHER_CLOSE: 'openmotion:env-switcher:close',
} as const;

export const SPLASH_ALLOWED_ACTIONS = [
  'retryStartup',
  'exportDiagnostics',
  'windowControl',
  'resetEnvironment',
  'openEnvironmentSwitcher',
] as const;
export type SplashAllowedAction = (typeof SPLASH_ALLOWED_ACTIONS)[number];

const ALLOWED_SPLASH_FILENAMES = new Set(['splash.html', 'retry.html']);
const ALLOWED_ENV_SWITCHER_FILENAMES = new Set(['env-switcher.html']);

export type IpcSenderFrameLike = {
  url: string;
  parent?: IpcSenderFrameLike | null;
  top?: IpcSenderFrameLike | null;
};

export type IpcWebContentsLike = {
  id: number;
  mainFrame?: IpcSenderFrameLike | null;
  isDestroyed?: () => boolean;
};

export type IpcWindowLike = {
  isDestroyed?: () => boolean;
  webContents?: IpcWebContentsLike | null;
};

export type IpcEventLike = {
  sender?: IpcWebContentsLike | null;
  senderFrame?: IpcSenderFrameLike | null;
};

export type PrivilegedIpcGuardOptions = {
  /** Registered main Studio BrowserWindow. Only this window may invoke privileged host IPC. */
  mainWindow: IpcWindowLike | null | undefined;
  /** Release channel controlling built-in domain scope ('stable' | 'test' | 'dev'). */
  channel: HostReleaseChannel;
  /**
   * Active allowed Studio origins (from verified signed config / runtime config).
   * Must NEVER include popup or external auth/IdP origins.
   */
  allowedOrigins?: readonly string[];
  /** Active Studio URL; its origin is included if within built-in domain scope. */
  studioUrl?: string;
  /** Permits http://127.0.0.1 and http://localhost only when channel === 'dev'. */
  allowLocalDevLoopback?: boolean;
  /**
   * Optional user-selected test/dev Studio origin (e.g. local loopback or an
   * Orbit lane origin explicitly validated by the test/dev environment switcher).
   * Strictly ignored when `channel === 'stable'`.
   */
  explicitTestStudioOrigin?: string;
  /** True while an explicit in-window login fallback session is active (denies privileged IPC). */
  inWindowAuthFallbackActive?: boolean;
};

export type PrivilegedIpcAuthSuccess = {
  ok: true;
  origin: string;
  url: string;
  webContentsId: number;
};

export type PrivilegedIpcAuthResult = PrivilegedIpcAuthSuccess | HostInvokeFailure;

export type SplashIpcGuardOptions = {
  /** Registered splash / retry BrowserWindow. */
  splashWindow: IpcWindowLike | null | undefined;
  /** Optional explicit allowlist of absolute file paths for splash.html / retry.html. */
  allowedFilePaths?: readonly string[];
};

export type SplashIpcAuthSuccess = {
  ok: true;
  action: SplashAllowedAction;
  filePath: string;
  webContentsId: number;
};

export type SplashIpcAuthResult = SplashIpcAuthSuccess | HostInvokeFailure;

function isAllowedPrivilegedProtocol(
  protocol: string,
  channel: HostReleaseChannel,
  allowLocalDevLoopback: boolean,
): boolean {
  if (protocol === 'https:') return true;
  if (protocol === 'http:' && channel === 'dev' && allowLocalDevLoopback) return true;
  return false;
}

function normalizeOriginCandidate(
  rawUrl: string,
  channel: HostReleaseChannel,
  allowLocalDevLoopback: boolean,
): string | null {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  if (!isUrlInAllowedDomainScope(rawUrl, { channel, allowLocalDevLoopback })) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) return null;
    if (!isAllowedPrivilegedProtocol(parsed.protocol, channel, allowLocalDevLoopback)) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Resolves the active set of allowed Studio origins strictly bounded by the
 * shell's built-in domain rules.
 *
 * When neither `allowedOrigins` nor `studioUrl` is supplied, falls back to the
 * channel's built-in default Studio URL. When explicit origins are supplied,
 * fails closed if none of them satisfy the built-in domain scope.
 */
function normalizeExplicitTestStudioOrigin(
  rawOrigin: string | undefined,
  channel: HostReleaseChannel,
): string | null {
  if (channel === 'stable' || typeof rawOrigin !== 'string' || !rawOrigin.trim()) {
    return null;
  }
  try {
    const parsed = new URL(rawOrigin.trim());
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === 'https:') {
      return parsed.origin;
    }
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname.toLowerCase() === '127.0.0.1' || parsed.hostname.toLowerCase() === 'localhost')
    ) {
      return parsed.origin;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveAllowedStudioOrigins(options: {
  channel: HostReleaseChannel;
  allowedOrigins?: readonly string[];
  studioUrl?: string;
  allowLocalDevLoopback?: boolean;
  explicitTestStudioOrigin?: string;
}): Set<string> {
  const allowLocalDev = Boolean(options.allowLocalDevLoopback && options.channel === 'dev');
  const explicitOrigin = normalizeExplicitTestStudioOrigin(
    options.explicitTestStudioOrigin,
    options.channel,
  );
  const hasExplicitInput =
    (Array.isArray(options.allowedOrigins) && options.allowedOrigins.length > 0) ||
    (typeof options.studioUrl === 'string' && options.studioUrl.trim().length > 0) ||
    Boolean(explicitOrigin);

  const candidates: string[] = [];
  if (hasExplicitInput) {
    if (Array.isArray(options.allowedOrigins)) {
      candidates.push(...options.allowedOrigins);
    }
    if (typeof options.studioUrl === 'string' && options.studioUrl.trim()) {
      candidates.push(options.studioUrl);
    }
  } else {
    candidates.push(DEFAULT_STUDIO_URLS[options.channel]);
  }

  const allowed = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeOriginCandidate(candidate, options.channel, allowLocalDev);
    if (normalized) {
      allowed.add(normalized);
    }
  }
  if (explicitOrigin) {
    allowed.add(explicitOrigin);
  }
  return allowed;
}

function isMainFrame(
  senderFrame: IpcSenderFrameLike | null | undefined,
  expectedMainFrame: IpcSenderFrameLike | null | undefined,
): boolean {
  if (!senderFrame) return false;
  if (senderFrame.parent !== undefined && senderFrame.parent !== null) {
    return false;
  }
  if (senderFrame.top !== undefined && senderFrame.top !== null && senderFrame.top !== senderFrame) {
    return false;
  }
  if (expectedMainFrame !== undefined && expectedMainFrame !== null) {
    return senderFrame === expectedMainFrame;
  }
  return true;
}

/**
 * Unified privileged IPC authorization guard.
 *
 * Verifies:
 * 1. The sender belongs to the registered `mainWindow.webContents.id` (denying
 *    popups, project previews, splash windows, and secondary windows).
 * 2. The `senderFrame` is the main frame (denying subframes and iframes).
 * 3. `senderFrame.url` parses to an allowed Studio origin inside the channel's
 *    built-in domain scope (denying external/IdP login pages, `file://`,
 *    `about:blank`, `data:`, and non-Studio subdomains).
 */
export function authorizePrivilegedIpcSender(
  event: IpcEventLike | null | undefined,
  options: PrivilegedIpcGuardOptions,
): PrivilegedIpcAuthResult {
  const mainWindow = options.mainWindow;
  if (!mainWindow || mainWindow.isDestroyed?.()) {
    return hostErr('UNAUTHORIZED', 'Main Studio window is not available');
  }

  const mainWebContents = mainWindow.webContents;
  if (!mainWebContents || mainWebContents.isDestroyed?.()) {
    return hostErr('UNAUTHORIZED', 'Main Studio webContents is not available');
  }

  const sender = event?.sender;
  if (!sender || sender.isDestroyed?.() || typeof sender.id !== 'number') {
    return hostErr('UNAUTHORIZED', 'IPC sender is missing or destroyed');
  }

  if (sender.id !== mainWebContents.id) {
    return hostErr('UNAUTHORIZED', 'IPC caller does not belong to the main Studio window');
  }

  const senderFrame = event?.senderFrame;
  if (!isMainFrame(senderFrame, mainWebContents.mainFrame)) {
    return hostErr('UNAUTHORIZED', 'Only the main Studio frame may invoke privileged host APIs');
  }

  if (options.inWindowAuthFallbackActive) {
    return hostErr('UNAUTHORIZED', 'Privileged host APIs are disabled during in-window sign-in');
  }

  const rawUrl = senderFrame?.url;
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return hostErr('ORIGIN_DENIED', 'IPC sender frame URL is missing');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return hostErr('ORIGIN_DENIED', 'IPC sender frame URL is invalid');
  }

  if (parsed.pathname === '/auth' || parsed.pathname.startsWith('/auth/')) {
    return hostErr('ORIGIN_DENIED', 'Privileged host APIs are disabled on authentication pages');
  }

  if (parsed.username || parsed.password) {
    return hostErr('ORIGIN_DENIED', 'IPC sender URL must not contain embedded credentials');
  }

  const allowLocalDev = Boolean(options.allowLocalDevLoopback && options.channel === 'dev');
  const explicitOrigin = normalizeExplicitTestStudioOrigin(
    options.explicitTestStudioOrigin,
    options.channel,
  );
  const matchesExplicitTestOrigin = Boolean(explicitOrigin && parsed.origin === explicitOrigin);

  if (!matchesExplicitTestOrigin) {
    if (!isAllowedPrivilegedProtocol(parsed.protocol, options.channel, allowLocalDev)) {
      return hostErr('ORIGIN_DENIED', `IPC sender protocol "${parsed.protocol}" is not permitted`);
    }

    if (
      !isUrlInAllowedDomainScope(rawUrl, {
        channel: options.channel,
        allowLocalDevLoopback: allowLocalDev,
      })
    ) {
      return hostErr('ORIGIN_DENIED', `Origin "${parsed.origin}" is outside the allowed domain scope`);
    }
  }

  const allowedOrigins = resolveAllowedStudioOrigins({
    channel: options.channel,
    allowedOrigins: options.allowedOrigins,
    studioUrl: options.studioUrl,
    allowLocalDevLoopback: allowLocalDev,
    explicitTestStudioOrigin: options.explicitTestStudioOrigin,
  });

  if (!allowedOrigins.has(parsed.origin)) {
    return hostErr('ORIGIN_DENIED', `Origin "${parsed.origin}" is not an allowed Studio origin`);
  }

  return {
    ok: true,
    origin: parsed.origin,
    url: parsed.href,
    webContentsId: sender.id,
  };
}

function normalizePathForComparison(rawPath: string): string {
  let normalized = rawPath.replace(/\\/g, '/');
  if (/^\/[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function parseSafeLocalHtmlFilePath(
  rawUrl: string,
  allowedFilenames: ReadonlySet<string> = ALLOWED_SPLASH_FILENAMES,
): string | null {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.hostname && parsed.hostname.toLowerCase() !== 'localhost') return null;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }

  if (!decodedPath || /[\0\r\n]/.test(decodedPath)) return null;
  const normalized = normalizePathForComparison(decodedPath);
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '..')) return null;

  const basename = segments[segments.length - 1] ?? '';
  if (!allowedFilenames.has(basename)) return null;

  return normalized;
}

/**
 * Separate minimal allowlist guard exclusively for local `splash.html` / `retry.html`
 * recovery actions (v1: `retryStartup` only).
 */
export function authorizeSplashSender(
  event: IpcEventLike | null | undefined,
  action: string,
  options: SplashIpcGuardOptions,
): SplashIpcAuthResult {
  if (!(SPLASH_ALLOWED_ACTIONS as readonly string[]).includes(action)) {
    return hostErr('POLICY_DENIED', `Action "${String(action)}" is not allowed on the splash channel`);
  }

  const splashWindow = options.splashWindow;
  if (!splashWindow || splashWindow.isDestroyed?.()) {
    return hostErr('UNAUTHORIZED', 'Splash window is not available');
  }

  const splashWebContents = splashWindow.webContents;
  if (!splashWebContents || splashWebContents.isDestroyed?.()) {
    return hostErr('UNAUTHORIZED', 'Splash webContents is not available');
  }

  const sender = event?.sender;
  if (!sender || sender.isDestroyed?.() || typeof sender.id !== 'number') {
    return hostErr('UNAUTHORIZED', 'IPC sender is missing or destroyed');
  }

  if (sender.id !== splashWebContents.id) {
    return hostErr('UNAUTHORIZED', 'IPC caller does not belong to the splash window');
  }

  const senderFrame = event?.senderFrame;
  if (!isMainFrame(senderFrame, splashWebContents.mainFrame)) {
    return hostErr('UNAUTHORIZED', 'Subframes are not permitted on the splash channel');
  }

  const filePath = parseSafeLocalHtmlFilePath(senderFrame?.url ?? '');
  if (!filePath) {
    return hostErr('ORIGIN_DENIED', 'Splash action requires local splash.html or retry.html');
  }

  if (Array.isArray(options.allowedFilePaths) && options.allowedFilePaths.length > 0) {
    const allowedSet = new Set(options.allowedFilePaths.map(normalizePathForComparison));
    if (!allowedSet.has(filePath)) {
      return hostErr('ORIGIN_DENIED', 'Splash file path is outside the allowed local bundle paths');
    }
  }

  return {
    ok: true,
    action: action as SplashAllowedAction,
    filePath,
    webContentsId: sender.id,
  };
}

/**
 * Guard for the test/dev-only local `env-switcher.html` modal window.
 * Always denies on `stable` builds.
 */
export function authorizeEnvSwitcherSender(
  event: IpcEventLike | null | undefined,
  options: {
    channel: HostReleaseChannel;
    envSwitcherWindow: IpcWindowLike | null | undefined;
    allowedFilePaths?: readonly string[];
  },
): { ok: true; filePath: string; webContentsId: number } | HostInvokeFailure {
  if (options.channel === 'stable') {
    return hostErr('POLICY_DENIED', 'Environment switching is disabled in stable releases');
  }
  const win = options.envSwitcherWindow;
  if (!win || win.isDestroyed?.()) {
    return hostErr('UNAUTHORIZED', 'Environment switcher window is not available');
  }
  const wc = win.webContents;
  if (!wc || wc.isDestroyed?.()) {
    return hostErr('UNAUTHORIZED', 'Environment switcher webContents is not available');
  }
  const sender = event?.sender;
  if (!sender || sender.isDestroyed?.() || typeof sender.id !== 'number' || sender.id !== wc.id) {
    return hostErr('UNAUTHORIZED', 'IPC caller does not belong to the environment switcher window');
  }
  const senderFrame = event?.senderFrame;
  if (!isMainFrame(senderFrame, wc.mainFrame)) {
    return hostErr('UNAUTHORIZED', 'Subframes are not permitted on the environment switcher channel');
  }
  const filePath = parseSafeLocalHtmlFilePath(senderFrame?.url ?? '', ALLOWED_ENV_SWITCHER_FILENAMES);
  if (!filePath) {
    return hostErr('ORIGIN_DENIED', 'Action requires local env-switcher.html');
  }
  if (Array.isArray(options.allowedFilePaths) && options.allowedFilePaths.length > 0) {
    const allowedSet = new Set(options.allowedFilePaths.map(normalizePathForComparison));
    if (!allowedSet.has(filePath)) {
      return hostErr('ORIGIN_DENIED', 'Environment switcher file path is outside allowed bundle paths');
    }
  }
  return { ok: true, filePath, webContentsId: sender.id };
}
