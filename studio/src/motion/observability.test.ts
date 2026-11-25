// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_CONFIG_GLOBAL_KEY,
  type BrowserObservabilityConfig,
} from '@openmotion/observability/config';
import {
  addObservabilityBreadcrumb,
  captureBrowserException,
  captureReactBoundaryError,
  createReactRootErrorHandlers,
  flushBrowserObservability,
  initBrowserObservability,
  isBrowserObservabilityEnabled,
  recordPerformanceMetric,
  resetBrowserObservabilityForTests,
  setObservabilityContext,
  waitForBrowserObservabilityReady,
  type SentryBrowserSdkLike,
} from '@openmotion/observability/browser';

const TEST_DSN = 'https://publickey@sentry.example.invalid/42';

function createFakeSdk() {
  let capturedOptions: Record<string, unknown> | null = null;
  const sdk: SentryBrowserSdkLike = {
    init: vi.fn((options) => {
      capturedOptions = options as Record<string, unknown>;
      return undefined;
    }) as unknown as SentryBrowserSdkLike['init'],
    browserTracingIntegration: vi.fn((opts) => ({
      name: 'BrowserTracing',
      opts,
    })) as unknown as SentryBrowserSdkLike['browserTracingIntegration'],
    captureException: vi.fn(() => 'evt-1'),
    captureReactException: vi.fn(() => 'react-evt-1'),
    reactErrorHandler: vi.fn(() => vi.fn()),
    setUser: vi.fn(),
    setTag: vi.fn(),
    setContext: vi.fn(),
    addBreadcrumb: vi.fn(),
    flush: vi.fn(async () => true),
    metrics: {
      count: vi.fn(),
      gauge: vi.fn(),
      distribution: vi.fn(),
    },
  };
  return {
    sdk,
    getOptions: () => capturedOptions,
  };
}

describe('@openmotion/observability/browser', () => {
  beforeEach(() => {
    resetBrowserObservabilityForTests();
    delete (window as unknown as Record<string, unknown>)[RUNTIME_CONFIG_GLOBAL_KEY];
  });

  afterEach(() => {
    resetBrowserObservabilityForTests();
    delete (window as unknown as Record<string, unknown>)[RUNTIME_CONFIG_GLOBAL_KEY];
  });

  it('stays completely disabled (no-op) and never triggers lazy loader when runtime config is absent', async () => {
    const loader = vi.fn(async () => createFakeSdk().sdk);
    expect(initBrowserObservability({ loader })).toBe(false);
    expect(isBrowserObservabilityEnabled()).toBe(false);
    expect(loader).not.toHaveBeenCalled();

    expect(captureBrowserException(new Error('ignored'))).toBeUndefined();
    expect(captureReactBoundaryError(new Error('ignored'), { componentStack: '' })).toBeUndefined();
    expect(createReactRootErrorHandlers()).toEqual({});
    setObservabilityContext({ userId: 'u-1', workspaceId: 'w-1', projectId: 'p-1' });
    recordPerformanceMetric('openmotion.studio.load_ms', 120, { unit: 'millisecond' });
    addObservabilityBreadcrumb({ category: 'studio', message: 'opened' });
    expect(await flushBrowserObservability()).toBe(false);
    expect(loader).not.toHaveBeenCalled();
  });

  it('lazily loads the Sentry SDK when configured and replays buffered early-boot calls', async () => {
    const config: BrowserObservabilityConfig = {
      dsn: TEST_DSN,
      environment: 'production',
      release: 'openmotion@1.0.0',
      tracesSampleRate: 0.1,
    };
    (window as unknown as Record<string, unknown>)[RUNTIME_CONFIG_GLOBAL_KEY] = config;

    const { sdk } = createFakeSdk();
    let resolveLoader!: (value: SentryBrowserSdkLike) => void;
    const loader = vi.fn(
      () =>
        new Promise<SentryBrowserSdkLike>((resolve) => {
          resolveLoader = resolve;
        }),
    );

    expect(initBrowserObservability({ loader })).toBe(true);
    expect(isBrowserObservabilityEnabled()).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(sdk.init).not.toHaveBeenCalled();

    // Early calls before the async chunk arrives are buffered cleanly
    setObservabilityContext({ userId: 'u-early', workspaceId: 'ws-early', projectId: 'p-early' });
    addObservabilityBreadcrumb({ category: 'boot', message: 'starting' });
    recordPerformanceMetric('openmotion.studio.load_ms', 88, { unit: 'millisecond' });
    const rootHandlers = createReactRootErrorHandlers();
    rootHandlers.onUncaughtError?.(new Error('early root boom'), { componentStack: '\n in Root' });

    resolveLoader(sdk);
    expect(await waitForBrowserObservabilityReady()).toBe(true);

    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.setUser).toHaveBeenCalledWith({ id: 'u-early' });
    expect(sdk.setTag).toHaveBeenCalledWith('workspace_id', 'ws-early');
    expect(sdk.setTag).toHaveBeenCalledWith('project_id', 'p-early');
    expect(sdk.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'boot', message: 'starting' }),
    );
    expect(sdk.metrics.distribution).toHaveBeenCalledWith('openmotion.studio.load_ms', 88, {
      unit: 'millisecond',
    });
    expect(sdk.setTag).toHaveBeenCalledWith('error_boundary', 'ReactRootUncaught');
    expect(sdk.captureReactException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'early root boom' }),
      { componentStack: '\n in Root' },
    );
  });

  it('fails closed cleanly if the lazy Sentry SDK chunk fails to load', async () => {
    (window as unknown as Record<string, unknown>)[RUNTIME_CONFIG_GLOBAL_KEY] = {
      dsn: TEST_DSN,
      environment: 'production',
      tracesSampleRate: 0.1,
    };
    const loader = vi.fn(async () => {
      throw new Error('chunk fetch failed');
    });

    expect(initBrowserObservability({ loader })).toBe(true);
    expect(await waitForBrowserObservabilityReady()).toBe(false);
    expect(isBrowserObservabilityEnabled()).toBe(false);
  });

  it('initializes from window runtime config with privacy, tracing, sanitization, and session cap', async () => {
    const config: BrowserObservabilityConfig = {
      dsn: TEST_DSN,
      environment: 'production',
      release: 'openmotion@1.0.0',
      tracesSampleRate: 0.25,
      previewOrigin: 'https://preview.openmotion.example.com',
      appVersion: '1.0.0',
      deploymentMode: 'cloud-container',
    };
    (window as unknown as Record<string, unknown>)[RUNTIME_CONFIG_GLOBAL_KEY] = config;

    const { sdk, getOptions } = createFakeSdk();
    expect(initBrowserObservability({ sdk })).toBe(true);
    // Idempotent second call
    expect(initBrowserObservability({ sdk })).toBe(true);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(isBrowserObservabilityEnabled()).toBe(true);

    const options = getOptions()!;
    expect(options.dsn).toBe(TEST_DSN);
    expect(options.environment).toBe('production');
    expect(options.release).toBe('openmotion@1.0.0');
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    });
    expect(options.tracesSampleRate).toBe(0.25);
    expect(sdk.browserTracingIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        instrumentPageLoad: true,
        instrumentNavigation: true,
        enableLongTask: true,
        enableLongAnimationFrame: true,
      }),
    );

    // Trace propagation only matches same-origin API routes (never S3 presigned URLs)
    const targets = options.tracePropagationTargets as Array<string | RegExp>;
    expect(targets.some((t) => t instanceof RegExp && t.test('/motion-api/projects'))).toBe(true);
    expect(
      targets.some((t) => t instanceof RegExp && t.test('https://s3.example.com/bucket/object')),
    ).toBe(false);

    // beforeSend filters noise & preview origin, sanitizes URLs, and caps session error volume at 50
    const beforeSend = options.beforeSend as (
      event: Record<string, unknown>,
      hint?: Record<string, unknown>,
    ) => Record<string, unknown> | null;
    expect(beforeSend({ message: 'ResizeObserver loop limit exceeded' })).toBeNull();
    expect(
      beforeSend({
        exception: {
          values: [
            {
              type: 'Error',
              value: 'preview error',
              stacktrace: {
                frames: [{ abs_path: 'https://preview.openmotion.example.com/api/projects/p1/preview' }],
              },
            },
          ],
        },
      }),
    ).toBeNull();

    const sanitized = beforeSend({
      message: 'Failed fetch https://motion.example.com/api/projects/p1/preview?preview_token=secret999',
      request: { cookies: { om_session: 'secret' }, data: { body: 'private' } },
    });
    expect(sanitized).not.toBeNull();
    expect(String(sanitized?.message)).not.toContain('secret999');
    expect((sanitized?.request as Record<string, unknown>)?.cookies).toBeUndefined();

    // 49 more allowed events hit the 50-event session cap; 51st is dropped
    for (let i = 0; i < 49; i++) {
      expect(beforeSend({ message: `err-${i}` })).not.toBeNull();
    }
    expect(beforeSend({ message: 'err-over-cap' })).toBeNull();

    // beforeBreadcrumb drops Sentry ingest URLs
    const beforeBreadcrumb = options.beforeBreadcrumb as (
      crumb: Record<string, unknown>,
    ) => Record<string, unknown> | null;
    expect(
      beforeBreadcrumb({ category: 'fetch', data: { url: 'https://sentry.example.invalid/api/42/envelope/' } }),
    ).toBeNull();

    // React root handlers omit onCaughtError to avoid duplicating ErrorBoundary reports
    const rootHandlers = createReactRootErrorHandlers();
    expect(typeof rootHandlers.onUncaughtError).toBe('function');
    expect(typeof rootHandlers.onRecoverableError).toBe('function');
    expect('onCaughtError' in rootHandlers).toBe(false);

    // Boundary capture and non-PII context tagging
    expect(
      captureReactBoundaryError(new Error('crash'), { componentStack: '\n in Timeline' }, 'StudioErrorBoundary'),
    ).toBe('react-evt-1');
    expect(sdk.setTag).toHaveBeenCalledWith('error_boundary', 'StudioErrorBoundary');
    expect(sdk.captureReactException).toHaveBeenCalledWith(expect.any(Error), {
      componentStack: '\n in Timeline',
    });

    setObservabilityContext({
      userId: 'user-123',
      workspaceId: 'ws-456',
      workspaceRole: 'editor',
      projectId: 'proj-789',
      sessionId: 'sess-1',
      page: 'editor',
      authMode: 'oidc',
      hostKind: 'desktop',
      shellVersion: '0.2.1',
      hostPlatform: 'darwin',
      releaseChannel: 'stable',
    });
    expect(sdk.setUser).toHaveBeenCalledWith({ id: 'user-123' });
    expect(sdk.setTag).toHaveBeenCalledWith('workspace_id', 'ws-456');
    expect(sdk.setTag).toHaveBeenCalledWith('project_id', 'proj-789');
    expect(sdk.setTag).toHaveBeenCalledWith('studio_page', 'editor');
    expect(sdk.setTag).toHaveBeenCalledWith('host_kind', 'desktop');
    expect(sdk.setTag).toHaveBeenCalledWith('shell_version', '0.2.1');
    expect(sdk.setTag).toHaveBeenCalledWith('host_platform', 'darwin');
    expect(sdk.setTag).toHaveBeenCalledWith('release_channel', 'stable');

    // Performance metrics
    recordPerformanceMetric('openmotion.preview.first_frame_ms', 412, {
      unit: 'millisecond',
      attributes: { clip_count: 5 },
    });
    recordPerformanceMetric('openmotion.preview.first_frame_ms', -10, { unit: 'millisecond' });
    expect(sdk.metrics.distribution).toHaveBeenCalledTimes(1);
    expect(sdk.metrics.distribution).toHaveBeenCalledWith('openmotion.preview.first_frame_ms', 412, {
      unit: 'millisecond',
      attributes: { clip_count: 5 },
    });

    expect(await flushBrowserObservability(500)).toBe(true);
    expect(sdk.flush).toHaveBeenCalledWith(500);
  });
});
