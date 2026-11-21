import type * as SentryTypes from '@sentry/react';
import type { ErrorInfo } from 'react';
import {
  readBrowserObservabilityConfig,
  type BrowserObservabilityConfig,
} from './config.ts';
import {
  sanitizeSentryBreadcrumb,
  sanitizeSentryEvent,
  sanitizeText,
  shouldDropBrowserEvent,
  type SentryLikeBreadcrumb,
  type SentryLikeEvent,
  type SentryLikeEventHint,
} from './sanitize.ts';

const MAX_ERROR_EVENTS_PER_SESSION = 50;
const MAX_QUEUED_BOOT_OPERATIONS = 50;
const DEFAULT_TRACE_PROPAGATION_TARGETS: ReadonlyArray<string | RegExp> = [
  /^\/(?:api|motion-api)\//,
];

export interface SentryBrowserSdkLike {
  init: typeof SentryTypes.init;
  browserTracingIntegration: typeof SentryTypes.browserTracingIntegration;
  captureException: typeof SentryTypes.captureException;
  captureReactException: typeof SentryTypes.captureReactException;
  reactErrorHandler: typeof SentryTypes.reactErrorHandler;
  setUser: typeof SentryTypes.setUser;
  setTag: typeof SentryTypes.setTag;
  setContext: typeof SentryTypes.setContext;
  addBreadcrumb: typeof SentryTypes.addBreadcrumb;
  flush: typeof SentryTypes.flush;
  metrics: typeof SentryTypes.metrics;
}

export interface InitBrowserObservabilityOptions {
  readonly config?: BrowserObservabilityConfig | null;
  readonly sdk?: SentryBrowserSdkLike;
  readonly loader?: () => Promise<SentryBrowserSdkLike>;
}

export interface ObservabilityContextPatch {
  readonly userId?: string | null;
  readonly workspaceId?: string | null;
  readonly workspaceRole?: string | null;
  readonly projectId?: string | null;
  readonly sessionId?: string | null;
  readonly page?: string | null;
  readonly authMode?: string | null;
}

export interface CaptureExceptionContext {
  readonly area?: string;
  readonly tags?: Record<string, string>;
  readonly extra?: Record<string, unknown>;
}

export interface PerformanceMetricOptions {
  readonly unit?: 'millisecond' | 'second' | 'none' | 'ratio';
  readonly attributes?: Record<string, string | number | boolean>;
}

export interface ObservabilityBreadcrumbInput {
  readonly category: string;
  readonly message?: string;
  readonly level?: 'info' | 'warning' | 'error';
  readonly data?: Record<string, string | number | boolean>;
}

type QueuedOperation =
  | { readonly kind: 'exception'; readonly error: unknown; readonly context: CaptureExceptionContext }
  | {
      readonly kind: 'react_boundary';
      readonly error: Error;
      readonly componentStack?: string;
      readonly boundaryName: string;
    }
  | { readonly kind: 'metric'; readonly name: string; readonly value: number; readonly options: PerformanceMetricOptions }
  | { readonly kind: 'breadcrumb'; readonly breadcrumb: ObservabilityBreadcrumbInput };

let activeSdk: SentryBrowserSdkLike | null = null;
let activeConfig: BrowserObservabilityConfig | null = null;
let enabled = false;
let loadPromise: Promise<boolean> | null = null;
let sentErrorEvents = 0;
let pendingContext: ObservabilityContextPatch = {};
let queuedOperations: QueuedOperation[] = [];
let removeEarlyBootListeners: (() => void) | null = null;
let bootEpoch = 0;

function extractOrigin(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveTracePropagationTargets(
  config: BrowserObservabilityConfig,
): Array<string | RegExp> {
  if (config.tracePropagationTargets && config.tracePropagationTargets.length > 0) {
    return [...config.tracePropagationTargets];
  }
  const targets: Array<string | RegExp> = [...DEFAULT_TRACE_PROPAGATION_TARGETS];
  if (typeof window !== 'undefined' && window.location?.origin) {
    targets.push(new RegExp(`^${escapeRegExp(window.location.origin)}/(?:api|motion-api)/`));
  }
  return targets;
}

function buildDenyUrls(previewOrigin: string | null | undefined): Array<string | RegExp> {
  const deny: Array<string | RegExp> = [/^(?:chrome|moz|safari|safari-web)-extension:\/\//i];
  if (previewOrigin) {
    deny.push(new RegExp(`^${escapeRegExp(previewOrigin)}(?:/|$)`, 'i'));
  }
  return deny;
}

function isEmbeddedPresentation(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('embed') === '1';
  } catch {
    return false;
  }
}

function enqueueOperation(op: QueuedOperation): void {
  if (queuedOperations.length >= MAX_QUEUED_BOOT_OPERATIONS) return;
  queuedOperations.push(op);
}

function applyContextToSdk(sdk: SentryBrowserSdkLike, patch: ObservabilityContextPatch): void {
  if ('userId' in patch) {
    const id = patch.userId?.trim();
    sdk.setUser(id ? { id } : null);
  }
  if ('workspaceId' in patch) {
    sdk.setTag('workspace_id', patch.workspaceId?.trim() || undefined);
  }
  if ('workspaceRole' in patch) {
    sdk.setTag('workspace_role', patch.workspaceRole?.trim() || undefined);
  }
  if ('projectId' in patch) {
    sdk.setTag('project_id', patch.projectId?.trim() || undefined);
  }
  if ('authMode' in patch) {
    sdk.setTag('auth_mode', patch.authMode?.trim() || undefined);
  }
  if ('page' in patch) {
    sdk.setTag('studio_page', patch.page?.trim() || undefined);
  }
  if ('sessionId' in patch) {
    sdk.setContext(
      'studio_session',
      patch.sessionId?.trim() ? { session_id: patch.sessionId.trim() } : null,
    );
  }
}

function replayQueuedOperations(sdk: SentryBrowserSdkLike): void {
  const contextSnapshot = pendingContext;
  pendingContext = {};
  if (Object.keys(contextSnapshot).length > 0) {
    applyContextToSdk(sdk, contextSnapshot);
  }

  const pending = queuedOperations;
  queuedOperations = [];
  for (const op of pending) {
    try {
      if (op.kind === 'breadcrumb') {
        sdk.addBreadcrumb({
          category: op.breadcrumb.category,
          ...(op.breadcrumb.message ? { message: sanitizeText(op.breadcrumb.message) } : {}),
          ...(op.breadcrumb.level ? { level: op.breadcrumb.level } : {}),
          ...(op.breadcrumb.data ? { data: op.breadcrumb.data } : {}),
        });
      } else if (op.kind === 'metric') {
        sdk.metrics.distribution(op.name, op.value, {
          ...(op.options.unit ? { unit: op.options.unit } : {}),
          ...(op.options.attributes ? { attributes: op.options.attributes } : {}),
        });
      } else if (op.kind === 'react_boundary') {
        sdk.setTag('error_boundary', op.boundaryName);
        sdk.captureReactException(op.error, {
          componentStack: op.componentStack,
        });
      } else if (op.kind === 'exception') {
        const tags: Record<string, string> = { ...(op.context.tags ?? {}) };
        if (op.context.area) tags.area = op.context.area;
        sdk.captureException(op.error, {
          ...(Object.keys(tags).length > 0 ? { tags } : {}),
          ...(op.context.extra ? { extra: op.context.extra } : {}),
        });
      }
    } catch {
      // Never allow buffered telemetry replay to throw.
    }
  }
}

function installEarlyBootListeners(): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const onError = (event: ErrorEvent) => {
    const err = event.error instanceof Error ? event.error : new Error(event.message || 'Unhandled error');
    enqueueOperation({ kind: 'exception', error: err, context: { area: 'early_boot_error' } });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const err = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    enqueueOperation({ kind: 'exception', error: err, context: { area: 'early_boot_rejection' } });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

function initializeSdkInstance(
  sdk: SentryBrowserSdkLike,
  config: BrowserObservabilityConfig,
): boolean {
  const sanitizeOptions = {
    previewOrigin: config.previewOrigin ?? null,
    dsnOrigin: extractOrigin(config.dsn),
  };

  try {
    const integrations =
      config.tracesSampleRate > 0
        ? [
            sdk.browserTracingIntegration({
              instrumentPageLoad: true,
              instrumentNavigation: true,
              enableLongTask: true,
              enableLongAnimationFrame: true,
            }),
          ]
        : [];

    sdk.init({
      dsn: config.dsn,
      environment: config.environment,
      ...(config.release ? { release: config.release } : {}),
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
      tracesSampleRate: config.tracesSampleRate,
      tracePropagationTargets: resolveTracePropagationTargets(config),
      integrations,
      ignoreErrors: [/ResizeObserver loop/i, /MEDIA_ERR_SRC_NOT_SUPPORTED/i],
      denyUrls: buildDenyUrls(config.previewOrigin),
      beforeSend(event, hint) {
        if (
          shouldDropBrowserEvent(
            event as unknown as SentryLikeEvent,
            hint as SentryLikeEventHint,
            sanitizeOptions,
          )
        ) {
          return null;
        }
        if (sentErrorEvents >= MAX_ERROR_EVENTS_PER_SESSION) {
          return null;
        }
        sentErrorEvents += 1;
        return sanitizeSentryEvent(event as unknown as SentryLikeEvent, sanitizeOptions) as typeof event;
      },
      beforeSendTransaction(event) {
        return sanitizeSentryEvent(event as unknown as SentryLikeEvent, sanitizeOptions) as typeof event;
      },
      beforeBreadcrumb(breadcrumb) {
        return sanitizeSentryBreadcrumb(
          breadcrumb as unknown as SentryLikeBreadcrumb,
          sanitizeOptions,
        ) as typeof breadcrumb | null;
      },
    });

    sdk.setTag('app_surface', 'studio-web');
    sdk.setTag('deployment_mode', config.deploymentMode ?? 'cloud-container');
    if (config.appVersion) sdk.setTag('app_version', config.appVersion);
    sdk.setTag('embedded', isEmbeddedPresentation() ? 'true' : 'false');

    activeSdk = sdk;
    removeEarlyBootListeners?.();
    removeEarlyBootListeners = null;
    replayQueuedOperations(sdk);
    return true;
  } catch {
    removeEarlyBootListeners?.();
    removeEarlyBootListeners = null;
    enabled = false;
    activeConfig = null;
    activeSdk = null;
    pendingContext = {};
    queuedOperations = [];
    return false;
  }
}

/**
 * Initializes Web Sentry from runtime-injected config (`window.__OPENMOTION_OBSERVABILITY__`)
 * or an explicitly supplied config object.
 *
 * When unconfigured (no DSN), returns `false` synchronously and never imports `@sentry/react`,
 * guaranteeing zero bundle download and zero network overhead for local/self-hosted users.
 * When configured, lazily code-splits and loads `@sentry/react` while buffering any early
 * errors, context tags, or metrics until initialization finishes.
 */
export function initBrowserObservability(
  options: InitBrowserObservabilityOptions = {},
): boolean {
  if (enabled) return true;

  const config =
    options.config !== undefined ? options.config : readBrowserObservabilityConfig();
  if (!config) return false;

  enabled = true;
  activeConfig = config;
  const currentEpoch = ++bootEpoch;

  if (options.sdk) {
    const ok = initializeSdkInstance(options.sdk, config);
    loadPromise = Promise.resolve(ok);
    return ok;
  }

  removeEarlyBootListeners = installEarlyBootListeners();
  const loadSdk = options.loader ?? (() => import('@sentry/react'));
  let sdkPromise: Promise<SentryBrowserSdkLike>;
  try {
    sdkPromise = Promise.resolve(loadSdk());
  } catch (error) {
    sdkPromise = Promise.reject(error);
  }
  loadPromise = sdkPromise
    .then((sdk) => {
      if (currentEpoch !== bootEpoch || !enabled) return false;
      return initializeSdkInstance(sdk, config);
    })
    .catch(() => {
      if (currentEpoch !== bootEpoch) return false;
      removeEarlyBootListeners?.();
      removeEarlyBootListeners = null;
      enabled = false;
      activeConfig = null;
      activeSdk = null;
      pendingContext = {};
      queuedOperations = [];
      return false;
    });

  return true;
}

export function isBrowserObservabilityEnabled(): boolean {
  return enabled;
}

export function getActiveBrowserObservabilityConfig(): BrowserObservabilityConfig | null {
  return activeConfig;
}

export async function waitForBrowserObservabilityReady(): Promise<boolean> {
  if (!loadPromise) return activeSdk !== null;
  return loadPromise;
}

export function captureBrowserException(
  error: unknown,
  context: CaptureExceptionContext = {},
): string | undefined {
  if (!enabled) return undefined;
  if (!activeSdk) {
    enqueueOperation({ kind: 'exception', error, context });
    return undefined;
  }
  try {
    const tags: Record<string, string> = { ...(context.tags ?? {}) };
    if (context.area) tags.area = context.area;
    return activeSdk.captureException(error, {
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
      ...(context.extra ? { extra: context.extra } : {}),
    });
  } catch {
    return undefined;
  }
}

export function captureReactBoundaryError(
  error: Error,
  info: Pick<ErrorInfo, 'componentStack'>,
  boundaryName = 'StudioErrorBoundary',
): string | undefined {
  if (!enabled) return undefined;
  if (!activeSdk) {
    enqueueOperation({
      kind: 'react_boundary',
      error,
      componentStack: info.componentStack ?? undefined,
      boundaryName,
    });
    return undefined;
  }
  try {
    activeSdk.setTag('error_boundary', boundaryName);
    return activeSdk.captureReactException(error, {
      componentStack: info.componentStack ?? undefined,
    });
  } catch {
    return undefined;
  }
}

/**
 * Returns React 19 `createRoot` callbacks for uncaught/recoverable errors.
 * Intentionally omits `onCaughtError` so errors already handled by `StudioErrorBoundary`
 * are reported once via `captureReactBoundaryError`.
 */
export function createReactRootErrorHandlers(): {
  onUncaughtError?: (error: unknown, errorInfo: ErrorInfo) => void;
  onRecoverableError?: (error: unknown, errorInfo: ErrorInfo) => void;
} {
  if (!enabled) return {};
  return {
    onUncaughtError(error: unknown, errorInfo: ErrorInfo) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      captureReactBoundaryError(normalized, errorInfo, 'ReactRootUncaught');
    },
    onRecoverableError(error: unknown, errorInfo: ErrorInfo) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      captureReactBoundaryError(normalized, errorInfo, 'ReactRootRecoverable');
    },
  };
}

/**
 * Updates non-PII contextual tags (never email, display name, or tokens).
 */
export function setObservabilityContext(patch: ObservabilityContextPatch): void {
  if (!enabled) return;
  if (!activeSdk) {
    pendingContext = { ...pendingContext, ...patch };
    return;
  }
  try {
    applyContextToSdk(activeSdk, patch);
  } catch {
    // Observability context updates must never disrupt editor execution.
  }
}

export function recordPerformanceMetric(
  name: string,
  value: number,
  options: PerformanceMetricOptions = {},
): void {
  if (!enabled || !Number.isFinite(value) || value < 0) return;
  if (!activeSdk) {
    enqueueOperation({ kind: 'metric', name, value, options });
    return;
  }
  try {
    activeSdk.metrics.distribution(name, value, {
      ...(options.unit ? { unit: options.unit } : {}),
      ...(options.attributes ? { attributes: options.attributes } : {}),
    });
  } catch {
    // Performance measurement must never break the caller.
  }
}

export function addObservabilityBreadcrumb(breadcrumb: ObservabilityBreadcrumbInput): void {
  if (!enabled) return;
  if (!activeSdk) {
    enqueueOperation({ kind: 'breadcrumb', breadcrumb });
    return;
  }
  try {
    activeSdk.addBreadcrumb({
      category: breadcrumb.category,
      ...(breadcrumb.message ? { message: sanitizeText(breadcrumb.message) } : {}),
      ...(breadcrumb.level ? { level: breadcrumb.level } : {}),
      ...(breadcrumb.data ? { data: breadcrumb.data } : {}),
    });
  } catch {
    // Breadcrumbs are best effort.
  }
}

export async function flushBrowserObservability(timeoutMs = 2000): Promise<boolean> {
  if (!enabled) return false;
  try {
    if (loadPromise && !activeSdk) {
      await Promise.race([
        loadPromise,
        new Promise<void>((resolve) => {
          setTimeout(resolve, timeoutMs);
        }),
      ]);
    }
    if (!activeSdk) return false;
    return await activeSdk.flush(timeoutMs);
  } catch {
    return false;
  }
}

export function resetBrowserObservabilityForTests(): void {
  bootEpoch += 1;
  removeEarlyBootListeners?.();
  removeEarlyBootListeners = null;
  activeSdk = null;
  activeConfig = null;
  enabled = false;
  loadPromise = null;
  sentErrorEvents = 0;
  pendingContext = {};
  queuedOperations = [];
}
