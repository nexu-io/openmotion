import {
  HOST_CAPABILITIES,
  HOST_CAPABILITY_VERSIONS,
  hostErr,
  hostOk,
  type DesktopPickDownloadDirResult,
  type DesktopPreferenceResetParams,
  type DesktopPreferenceSetParams,
  type DesktopPreferenceSetResult,
  type DesktopPreferencesSnapshot,
  type HostCapabilityDescriptor,
  type HostCapabilityStatus,
  type HostInvokeResult,
  type HostRuntimeInfo,
} from '../../shared/desktop-contract.ts';
import { validateHostMethodParams } from '../../shared/desktop-schemas.ts';
import type {
  DesktopAppInfo,
  DesktopChromeInsets,
  DesktopDiagnosticExportResult,
  DesktopUpdateState,
} from '../../shared/platform-host.ts';
import { HOST_IPC_CHANNELS } from './ipc-guard.ts';

export type CapabilityInvokeContext = {
  origin?: string;
  url?: string;
  webContentsId?: number;
};

export type CapabilityValidationResult<TParams = Record<string, unknown>> =
  | { ok: true; value: TParams }
  | { ok: false; message: string; details?: Record<string, unknown> };

export type CapabilityParamValidator<TParams = Record<string, unknown>> = (
  params: Record<string, unknown>,
) => CapabilityValidationResult<TParams>;

export type CapabilityMethodDefinition<
  TParams = Record<string, unknown>,
  TResult = unknown,
> = {
  validate?: CapabilityParamValidator<TParams>;
  handler: (
    params: TParams,
    ctx: CapabilityInvokeContext,
  ) => Promise<HostInvokeResult<TResult>> | HostInvokeResult<TResult>;
};

export type CapabilityModule = {
  name: string;
  version: string;
  status: HostCapabilityStatus;
  reason?: string;
  methods: Record<string, CapabilityMethodDefinition<any, any>>;
  events?: readonly string[];
};

export type CapabilityEventMessage = {
  capability: string;
  event: string;
  payload: unknown;
};

export type CapabilityEventSink = (message: CapabilityEventMessage) => void;

export type CapabilityRegistryOptions = {
  sinks?: readonly CapabilityEventSink[];
  onInternalError?: (info: { capability: string; method: string; error: unknown }) => void;
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isHostInvokeResult(value: unknown): value is HostInvokeResult {
  if (!isPlainObject(value) || typeof value.ok !== 'boolean') {
    return false;
  }
  if (value.ok === true) {
    return 'data' in value;
  }
  return (
    isPlainObject(value.error) &&
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string'
  );
}

/**
 * Main-process Capability Registry backing the universal 4-method bridge.
 *
 * Enforces:
 * - Unknown capabilities and methods return `UNSUPPORTED` (never throw).
 * - Unavailable capabilities return `UNSUPPORTED` with their declared reason.
 * - Non-object or schema-invalid parameters return `INVALID_PARAMS`.
 * - Unexpected handler throws are converted to sanitized `INTERNAL_ERROR`.
 */
export class CapabilityRegistry {
  private readonly modules = new Map<string, CapabilityModule>();
  private readonly sinks = new Set<CapabilityEventSink>();
  private readonly onInternalError?: (info: {
    capability: string;
    method: string;
    error: unknown;
  }) => void;

  constructor(options: CapabilityRegistryOptions = {}) {
    this.onInternalError = options.onInternalError;
    for (const sink of options.sinks ?? []) {
      this.sinks.add(sink);
    }
  }

  register(module: CapabilityModule): this {
    if (typeof module.name !== 'string' || !module.name.trim()) {
      throw new Error('Capability module name must be a non-empty string');
    }
    if (typeof module.version !== 'string' || !module.version.trim()) {
      throw new Error(`Capability module "${module.name}" version must be a non-empty string`);
    }
    this.modules.set(module.name, module);
    return this;
  }

  unregister(name: string): boolean {
    return this.modules.delete(name);
  }

  get(name: string): CapabilityModule | undefined {
    return this.modules.get(name);
  }

  has(name: string): boolean {
    return this.modules.has(name);
  }

  setStatus(name: string, status: HostCapabilityStatus, reason?: string): boolean {
    const existing = this.modules.get(name);
    if (!existing) return false;
    const { reason: _previousReason, ...rest } = existing;
    this.modules.set(name, {
      ...rest,
      status,
      ...(reason !== undefined ? { reason } : {}),
    });
    return true;
  }

  listCapabilities(): HostCapabilityDescriptor[] {
    const list: HostCapabilityDescriptor[] = [];
    for (const mod of this.modules.values()) {
      list.push({
        name: mod.name,
        version: mod.version,
        status: mod.status,
        ...(mod.reason !== undefined ? { reason: mod.reason } : {}),
        methods: Object.keys(mod.methods),
        events: [...(mod.events ?? [])],
      });
    }
    return list;
  }

  addEventSink(sink: CapabilityEventSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  emit(capability: string, event: string, payload: unknown): void {
    if (!capability || !event) return;
    const message: CapabilityEventMessage = { capability, event, payload };
    for (const sink of this.sinks) {
      try {
        sink(message);
      } catch {
        // Ignore failing/destroyed event sinks so remaining subscribers still receive events.
      }
    }
  }

  async invoke<T = unknown>(
    capability: unknown,
    method: unknown,
    params?: unknown,
    ctx: CapabilityInvokeContext = {},
  ): Promise<HostInvokeResult<T>> {
    try {
      if (typeof capability !== 'string' || !capability.trim()) {
        return hostErr('INVALID_PARAMS', 'Capability name must be a non-empty string');
      }
      if (typeof method !== 'string' || !method.trim()) {
        return hostErr('INVALID_PARAMS', 'Method name must be a non-empty string');
      }

      let normalizedParams: Record<string, unknown>;
      if (params === undefined) {
        normalizedParams = {};
      } else if (isPlainObject(params)) {
        normalizedParams = params;
      } else {
        return hostErr('INVALID_PARAMS', 'Invoke params must be a plain object');
      }

      const mod = this.modules.get(capability);
      if (!mod) {
        return hostErr('UNSUPPORTED', `Unsupported capability: ${capability}`);
      }

      if (mod.status === 'unavailable') {
        return hostErr(
          'UNSUPPORTED',
          mod.reason || `Capability "${capability}" is currently unavailable`,
        );
      }

      if (!Object.prototype.hasOwnProperty.call(mod.methods, method)) {
        return hostErr('UNSUPPORTED', `Unsupported method "${method}" on capability "${capability}"`);
      }

      const methodDef = mod.methods[method];
      let validatedParams: unknown = normalizedParams;
      if (methodDef.validate) {
        const validation = methodDef.validate(normalizedParams);
        if (!validation.ok) {
          return hostErr('INVALID_PARAMS', validation.message, validation.details);
        }
        validatedParams = validation.value;
      }

      const result = await methodDef.handler(validatedParams, ctx);
      if (!isHostInvokeResult(result)) {
        return hostErr('INTERNAL_ERROR', `Invalid response from capability "${capability}.${method}"`);
      }
      return result as HostInvokeResult<T>;
    } catch (error) {
      const capLabel = typeof capability === 'string' ? capability : '<invalid>';
      const methodLabel = typeof method === 'string' ? method : '<invalid>';
      try {
        this.onInternalError?.({ capability: capLabel, method: methodLabel, error });
      } catch {
        // Never allow logger errors to escape invoke().
      }
      return hostErr(
        'INTERNAL_ERROR',
        `Capability "${capLabel}.${methodLabel}" encountered an internal error`,
      );
    }
  }
}

export type EventSenderWebContentsLike = {
  isDestroyed?: () => boolean;
  send: (channel: string, payload: unknown) => void;
};

/**
 * Creates a safe event sink forwarding capability events to a BrowserWindow's
 * webContents over the frozen `openmotion:host:event` channel.
 */
export function createWebContentsEventSink(
  getWebContents: () => EventSenderWebContentsLike | null | undefined,
): CapabilityEventSink {
  return message => {
    const wc = getWebContents();
    if (!wc || wc.isDestroyed?.()) return;
    wc.send(HOST_IPC_CHANNELS.EVENT, message);
  };
}

// ---------------------------------------------------------------------------
// Shell Capability Module Builders (Window, Updater, Diagnostics, Account)
// ---------------------------------------------------------------------------

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

function validateThemeParams(
  params: Record<string, unknown>,
): CapabilityValidationResult<{ theme: 'light' | 'dark' | 'system' }> {
  const theme = params.theme;
  if (theme !== 'light' && theme !== 'dark' && theme !== 'system') {
    return { ok: false, message: 'Parameter "theme" must be "light", "dark", or "system"' };
  }
  return { ok: true, value: { theme } };
}

function validateTaskId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || /[\r\n\0]/.test(trimmed)) return null;
  return trimmed;
}

function validateSetTaskProgressParams(
  params: Record<string, unknown>,
): CapabilityValidationResult<{ taskId: string; progress: number | 'indeterminate' | null }> {
  const taskId = validateTaskId(params.taskId);
  if (!taskId) {
    return { ok: false, message: 'Parameter "taskId" must be a non-empty single-line string' };
  }
  const progress = params.progress;
  if (
    progress === null ||
    progress === 'indeterminate' ||
    (typeof progress === 'number' && Number.isFinite(progress) && progress >= -1 && progress <= 1)
  ) {
    return { ok: true, value: { taskId, progress } };
  }
  return {
    ok: false,
    message: 'Parameter "progress" must be a number in [-1, 1], "indeterminate", or null',
  };
}

function validateAcquireWakeLockParams(
  params: Record<string, unknown>,
): CapabilityValidationResult<{ taskId: string; reason?: string; ttlMs?: number }> {
  const taskId = validateTaskId(params.taskId);
  if (!taskId) {
    return { ok: false, message: 'Parameter "taskId" must be a non-empty single-line string' };
  }
  let reason: string | undefined;
  if (params.reason !== undefined) {
    const validReason = validateTaskId(params.reason);
    if (!validReason) {
      return { ok: false, message: 'Parameter "reason" must be a non-empty single-line string' };
    }
    reason = validReason;
  }
  let ttlMs: number | undefined;
  if (params.ttlMs !== undefined) {
    if (
      typeof params.ttlMs !== 'number' ||
      !Number.isInteger(params.ttlMs) ||
      params.ttlMs < 5_000 ||
      params.ttlMs > 3_600_000
    ) {
      return { ok: false, message: 'Parameter "ttlMs" must be an integer between 5000 and 3600000' };
    }
    ttlMs = params.ttlMs;
  }
  return {
    ok: true,
    value: {
      taskId,
      ...(reason !== undefined ? { reason } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    },
  };
}

function validateReleaseWakeLockParams(
  params: Record<string, unknown>,
): CapabilityValidationResult<{ taskId: string }> {
  const taskId = validateTaskId(params.taskId);
  if (!taskId) {
    return { ok: false, message: 'Parameter "taskId" must be a non-empty single-line string' };
  }
  return { ok: true, value: { taskId } };
}

function validateNotifyParams(
  params: Record<string, unknown>,
): CapabilityValidationResult<{
  title: string;
  body?: string;
  bounce?: boolean;
  silent?: boolean;
  whenUnfocusedOnly?: boolean;
}> {
  const title = validateTaskId(params.title);
  if (!title) {
    return { ok: false, message: 'Parameter "title" must be a non-empty single-line string' };
  }
  let body: string | undefined;
  if (params.body !== undefined) {
    if (typeof params.body !== 'string' || params.body.length > 512 || /[\0]/.test(params.body)) {
      return { ok: false, message: 'Parameter "body" must be a string up to 512 characters' };
    }
    body = params.body.trim();
  }
  for (const key of ['bounce', 'silent', 'whenUnfocusedOnly'] as const) {
    if (params[key] !== undefined && typeof params[key] !== 'boolean') {
      return { ok: false, message: `Parameter "${key}" must be a boolean` };
    }
  }
  return {
    ok: true,
    value: {
      title,
      ...(body !== undefined ? { body } : {}),
      ...(typeof params.bounce === 'boolean' ? { bounce: params.bounce } : {}),
      ...(typeof params.silent === 'boolean' ? { silent: params.silent } : {}),
      ...(typeof params.whenUnfocusedOnly === 'boolean'
        ? { whenUnfocusedOnly: params.whenUnfocusedOnly }
        : {}),
    },
  };
}

function validateExternalUrlParams(
  params: Record<string, unknown>,
): CapabilityValidationResult<{ url: string }> {
  const raw = params.url;
  if (typeof raw !== 'string') {
    return { ok: false, message: 'Parameter "url" must be a non-empty string' };
  }
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) {
    return { ok: false, message: 'Parameter "url" must be non-empty single-line text' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: 'Parameter "url" must be a valid URL' };
  }
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      message: `Unsupported external URL protocol: "${parsed.protocol}"`,
    };
  }
  return { ok: true, value: { url: trimmed } };
}

function validateStartSignInParams(
  params: Record<string, unknown>,
): CapabilityValidationResult<{ returnPath?: string }> {
  const returnPath = params.returnPath;
  if (returnPath === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof returnPath !== 'string') {
    return { ok: false, message: 'Parameter "returnPath" must be a string' };
  }
  if (/[\r\n\0]/.test(returnPath) || !returnPath.startsWith('/') || returnPath.startsWith('//')) {
    return {
      ok: false,
      message: 'Parameter "returnPath" must be a safe root-relative path',
    };
  }
  return { ok: true, value: { returnPath } };
}

export type WindowCapabilityDeps = {
  getChromeState: () => DesktopChromeInsets | Promise<DesktopChromeInsets>;
  setTheme: (theme: 'light' | 'dark' | 'system') => void | Promise<void>;
  minimize: () => void | Promise<void>;
  toggleMaximize: () => void | Promise<void>;
  close: () => void | Promise<void>;
  openExternal: (url: string) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  notifyRendererReady: () => void | Promise<void>;
  retryStartup?: () => void | Promise<void>;
  continueToStudio?: () => void | Promise<void>;
  setTaskProgress?: (input: {
    taskId: string;
    progress: number | 'indeterminate' | null;
  }) => { progress: number } | Promise<{ progress: number }>;
  acquireWakeLock?: (input: {
    taskId: string;
    reason?: string;
    ttlMs?: number;
  }) => { active: boolean; leaseCount: number } | Promise<{ active: boolean; leaseCount: number }>;
  releaseWakeLock?: (input: {
    taskId: string;
  }) => { active: boolean; leaseCount: number } | Promise<{ active: boolean; leaseCount: number }>;
  notify?: (input: {
    title: string;
    body?: string;
    bounce?: boolean;
    silent?: boolean;
    whenUnfocusedOnly?: boolean;
  }) => { delivered: boolean; bounced?: boolean } | Promise<{ delivered: boolean; bounced?: boolean }>;
  status?: HostCapabilityStatus;
  reason?: string;
};

export function createWindowCapabilityModule(deps: WindowCapabilityDeps): CapabilityModule {
  return {
    name: HOST_CAPABILITIES.WINDOW,
    version: HOST_CAPABILITY_VERSIONS[HOST_CAPABILITIES.WINDOW],
    status: deps.status ?? 'available',
    ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
    events: ['chromeState', 'menuAction', 'themeChanged', 'focus', 'visibility', 'resizing', 'deepLink'],
    methods: {
      getChromeState: {
        handler: async () => hostOk(await deps.getChromeState()),
      },
      setTheme: {
        validate: validateThemeParams,
        handler: async ({ theme }: { theme: 'light' | 'dark' | 'system' }) => {
          await deps.setTheme(theme);
          return hostOk({ theme });
        },
      },
      minimize: {
        handler: async () => {
          await deps.minimize();
          return hostOk({ ok: true });
        },
      },
      toggleMaximize: {
        handler: async () => {
          await deps.toggleMaximize();
          return hostOk({ ok: true });
        },
      },
      close: {
        handler: async () => {
          await deps.close();
          return hostOk({ ok: true });
        },
      },
      openExternal: {
        validate: validateExternalUrlParams,
        handler: async ({ url }: { url: string }) => hostOk(await deps.openExternal(url)),
      },
      rendererReady: {
        handler: async () => {
          await deps.notifyRendererReady();
          return hostOk({ ok: true });
        },
      },
      retryStartup: {
        handler: async () => {
          if (!deps.retryStartup) {
            return hostErr('UNSUPPORTED', 'Startup retry is not supported in this host');
          }
          await deps.retryStartup();
          return hostOk({ ok: true });
        },
      },
      continueToStudio: {
        handler: async () => {
          if (!deps.continueToStudio) {
            return hostErr('UNSUPPORTED', 'Splash transition is not supported in this host');
          }
          await deps.continueToStudio();
          return hostOk({ ok: true });
        },
      },
      setTaskProgress: {
        validate: validateSetTaskProgressParams,
        handler: async (input: { taskId: string; progress: number | 'indeterminate' | null }) => {
          if (!deps.setTaskProgress) {
            return hostErr('UNSUPPORTED', 'Task progress reporting is not supported in this host');
          }
          return hostOk(await deps.setTaskProgress(input));
        },
      },
      acquireWakeLock: {
        validate: validateAcquireWakeLockParams,
        handler: async (input: { taskId: string; reason?: string; ttlMs?: number }) => {
          if (!deps.acquireWakeLock) {
            return hostErr('UNSUPPORTED', 'Wake lock control is not supported in this host');
          }
          return hostOk(await deps.acquireWakeLock(input));
        },
      },
      releaseWakeLock: {
        validate: validateReleaseWakeLockParams,
        handler: async (input: { taskId: string }) => {
          if (!deps.releaseWakeLock) {
            return hostErr('UNSUPPORTED', 'Wake lock control is not supported in this host');
          }
          return hostOk(await deps.releaseWakeLock(input));
        },
      },
      notify: {
        validate: validateNotifyParams,
        handler: async (input: {
          title: string;
          body?: string;
          bounce?: boolean;
          silent?: boolean;
          whenUnfocusedOnly?: boolean;
        }) => {
          if (!deps.notify) {
            return hostErr('UNSUPPORTED', 'Desktop notifications are not supported in this host');
          }
          return hostOk(await deps.notify(input));
        },
      },
    },
  };
}

export type UpdaterCapabilityDeps = {
  getUpdateState: () => DesktopUpdateState | Promise<DesktopUpdateState>;
  checkForUpdates: () => DesktopUpdateState | Promise<DesktopUpdateState>;
  downloadUpdate: () => DesktopUpdateState | Promise<DesktopUpdateState>;
  installUpdateNow: () => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  status?: HostCapabilityStatus;
  reason?: string;
};

export function createUpdaterCapabilityModule(deps: UpdaterCapabilityDeps): CapabilityModule {
  return {
    name: HOST_CAPABILITIES.UPDATER,
    version: HOST_CAPABILITY_VERSIONS[HOST_CAPABILITIES.UPDATER],
    status: deps.status ?? 'available',
    ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
    events: ['state'],
    methods: {
      getState: {
        handler: async () => hostOk(await deps.getUpdateState()),
      },
      checkForUpdates: {
        handler: async () => hostOk(await deps.checkForUpdates()),
      },
      downloadUpdate: {
        handler: async () => hostOk(await deps.downloadUpdate()),
      },
      installNow: {
        handler: async () => hostOk(await deps.installUpdateNow()),
      },
    },
  };
}

export type DiagnosticsCapabilityDeps = {
  getAppInfo: () => HostRuntimeInfo | DesktopAppInfo | Promise<HostRuntimeInfo | DesktopAppInfo>;
  exportLogs: () => DesktopDiagnosticExportResult | Promise<DesktopDiagnosticExportResult>;
  openLogsFolder: () =>
    | { ok: boolean; path?: string; error?: string }
    | Promise<{ ok: boolean; path?: string; error?: string }>;
  status?: HostCapabilityStatus;
  reason?: string;
};

export function createDiagnosticsCapabilityModule(
  deps: DiagnosticsCapabilityDeps,
): CapabilityModule {
  return {
    name: HOST_CAPABILITIES.DIAGNOSTICS,
    version: HOST_CAPABILITY_VERSIONS[HOST_CAPABILITIES.DIAGNOSTICS],
    status: deps.status ?? 'available',
    ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
    events: [],
    methods: {
      getAppInfo: {
        handler: async () => hostOk(await deps.getAppInfo()),
      },
      exportBundle: {
        handler: async () => hostOk(await deps.exportLogs()),
      },
      openLogsFolder: {
        handler: async () => hostOk(await deps.openLogsFolder()),
      },
    },
  };
}

export type AccountCapabilityDeps = {
  startSignIn: (params?: {
    returnPath?: string;
    switchAccount?: boolean;
  }) => Record<string, unknown> | Promise<Record<string, unknown>>;
  cancelSignIn: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  refreshAccount: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  getLoginState?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  openBillingPortal?: (params: { url: string }) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  openInWindowLogin?: (params?: { returnPath?: string }) => Record<string, unknown> | Promise<Record<string, unknown>>;
  signOut?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  status?: HostCapabilityStatus;
  reason?: string;
};

export function createAccountCapabilityModule(deps: AccountCapabilityDeps): CapabilityModule {
  return {
    name: HOST_CAPABILITIES.ACCOUNT,
    version: HOST_CAPABILITY_VERSIONS[HOST_CAPABILITIES.ACCOUNT],
    status: deps.status ?? 'available',
    ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
    events: ['state'],
    methods: {
      startBrowserLogin: {
        validate: params => {
          const candidate = params.returnPath !== undefined ? params.returnPath : params.returnTo;
          const base = validateStartSignInParams(
            candidate !== undefined ? { returnPath: candidate } : {},
          );
          if (!base.ok) return base;
          let switchAccount = params.switchAccount === true;
          if (!switchAccount && typeof params.loginUrl === 'string') {
            try {
              const parsed = new URL(params.loginUrl, 'https://example.invalid');
              if (parsed.searchParams.get('switch') === '1') {
                switchAccount = true;
              }
            } catch {
              // Ignore malformed loginUrl hint.
            }
          }
          return { ok: true, value: { ...base.value, switchAccount } };
        },
        handler: async (params: { returnPath?: string; switchAccount?: boolean }) =>
          hostOk(await deps.startSignIn(params)),
      },
      cancelLogin: {
        handler: async () => hostOk(await deps.cancelSignIn()),
      },
      getLoginState: {
        handler: async () =>
          hostOk(deps.getLoginState ? await deps.getLoginState() : await deps.refreshAccount()),
      },
      openBillingPortal: {
        validate: validateExternalUrlParams,
        handler: async ({ url }: { url: string }) => {
          if (!deps.openBillingPortal) {
            return hostErr('UNSUPPORTED', 'Billing portal open is not supported in this host');
          }
          return hostOk(await deps.openBillingPortal({ url }));
        },
      },
      openInWindowLogin: {
        validate: validateStartSignInParams,
        handler: async (params: { returnPath?: string }) => {
          if (!deps.openInWindowLogin) {
            return hostErr('UNSUPPORTED', 'In-window login fallback is not supported in this host');
          }
          return hostOk(await deps.openInWindowLogin(params));
        },
      },
      refresh: {
        handler: async () => hostOk(await deps.refreshAccount()),
      },
      signOut: {
        handler: async () => {
          if (!deps.signOut) {
            return hostErr('UNSUPPORTED', 'Sign-out is not supported in this host');
          }
          return hostOk(await deps.signOut());
        },
      },
    },
  };
}

export type PreferencesCapabilityDeps = {
  getAll: () => DesktopPreferencesSnapshot | Promise<DesktopPreferencesSnapshot>;
  set: (
    params: DesktopPreferenceSetParams,
  ) =>
    | HostInvokeResult<DesktopPreferenceSetResult>
    | Promise<HostInvokeResult<DesktopPreferenceSetResult>>;
  reset: (
    params: DesktopPreferenceResetParams,
  ) =>
    | HostInvokeResult<DesktopPreferencesSnapshot>
    | Promise<HostInvokeResult<DesktopPreferencesSnapshot>>;
  pickDownloadDir?: () =>
    | HostInvokeResult<DesktopPickDownloadDirResult>
    | Promise<HostInvokeResult<DesktopPickDownloadDirResult>>;
  relaunch?: () =>
    | HostInvokeResult<{ relaunching: boolean }>
    | Promise<HostInvokeResult<{ relaunching: boolean }>>;
  status?: HostCapabilityStatus;
  reason?: string;
};

export function createPreferencesCapabilityModule(
  deps: PreferencesCapabilityDeps,
): CapabilityModule {
  return {
    name: HOST_CAPABILITIES.PREFERENCES,
    version: HOST_CAPABILITY_VERSIONS[HOST_CAPABILITIES.PREFERENCES],
    status: deps.status ?? 'available',
    ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
    events: ['changed'],
    methods: {
      getAll: {
        handler: async params => {
          const checked = validateHostMethodParams(HOST_CAPABILITIES.PREFERENCES, 'getAll', params);
          if (!checked.ok) return checked;
          return hostOk(await deps.getAll());
        },
      },
      set: {
        handler: async params => {
          const checked = validateHostMethodParams<DesktopPreferenceSetParams>(
            HOST_CAPABILITIES.PREFERENCES,
            'set',
            params,
          );
          if (!checked.ok) return checked;
          return deps.set(checked.data);
        },
      },
      reset: {
        handler: async params => {
          const checked = validateHostMethodParams<DesktopPreferenceResetParams>(
            HOST_CAPABILITIES.PREFERENCES,
            'reset',
            params,
          );
          if (!checked.ok) return checked;
          return deps.reset(checked.data);
        },
      },
      pickDownloadDir: {
        handler: async params => {
          const checked = validateHostMethodParams(
            HOST_CAPABILITIES.PREFERENCES,
            'pickDownloadDir',
            params,
          );
          if (!checked.ok) return checked;
          if (!deps.pickDownloadDir) {
            return hostErr('UNSUPPORTED', 'Folder picker is not supported in this host');
          }
          return deps.pickDownloadDir();
        },
      },
      relaunch: {
        handler: async params => {
          const checked = validateHostMethodParams(HOST_CAPABILITIES.PREFERENCES, 'relaunch', params);
          if (!checked.ok) return checked;
          if (!deps.relaunch) {
            return hostErr('UNSUPPORTED', 'App relaunch is not supported in this host');
          }
          return deps.relaunch();
        },
      },
    },
  };
}
