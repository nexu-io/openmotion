/**
 * Web Connect Script loopback adapter (S2 <-> K9).
 *
 * Implements the frozen 4-method `UniversalHostBridge` over HTTP + SSE against
 * `http://127.0.0.1:<port>` so cloud Studio in a regular browser can drive the
 * exact same UI as the Electron desktop thin shell.
 *
 * Security invariant: pairing tokens live strictly in memory and are NEVER
 * written to localStorage, sessionStorage, cookies, or URLs.
 */

import {
  hostErr,
  type HostCapabilityDescriptor,
  type HostError,
  type HostErrorCode,
  type HostInvokeResult,
  type HostRuntimeInfo,
  type UniversalHostBridge,
} from '../../../shared/desktop-contract';
import {
  CONNECT_SCRIPT_DEFAULT_PORT,
  CONNECT_SCRIPT_ENDPOINTS,
  CONNECT_SCRIPT_HOST,
  CONNECT_SCRIPT_TOKEN_HEADER,
  type ConnectScriptEventMessage,
  type ConnectScriptHealthResponse,
  type ConnectScriptInvokeRequest,
} from '../../../shared/connect-script-protocol';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_INTERACTIVE_INVOKE_TIMEOUT_MS = 180_000;

function isInteractiveInvoke(capability: string, method: string): boolean {
  if (capability === 'atom.exec') return true;
  if (capability === 'atom.config' && (method === 'write' || method === 'restoreBackup')) return true;
  if (capability === 'atom.installComponent' && (method === 'install' || method === 'uninstall')) return true;
  if (capability === 'atom.credential' && method !== 'status') return true;
  return false;
}

export type LocalConnectBridgeConfig = {
  port?: number;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Extended timeout for interactive / approval-gated helper mutations (default 180s). */
  interactiveTimeoutMs?: number;
};

export type LocalConnectBridgeHandle = UniversalHostBridge & {
  readonly hostKind: 'connect-script';
  readonly port: number;
  readonly baseUrl: string;
  dispose: () => void;
};

export type LocalConnectStatus = {
  connected: boolean;
  port: number | null;
  info: HostRuntimeInfo | null;
};

export type ConnectLocalBridgeResult =
  | {
      ok: true;
      bridge: LocalConnectBridgeHandle;
      info: HostRuntimeInfo;
      capabilities: HostCapabilityDescriptor[];
    }
  | {
      ok: false;
      error: HostError;
    };

function normalizePort(rawPort?: number): number | null {
  const port = rawPort ?? CONNECT_SCRIPT_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

function buildBaseUrl(port: number): string {
  return `http://${CONNECT_SCRIPT_HOST}:${port}`;
}

function mapHttpStatusToErrorCode(status: number): HostErrorCode {
  if (status === 400) return 'INVALID_PARAMS';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'ORIGIN_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 409) return 'CONFLICT';
  if (status === 429 || status === 503) return 'BUSY';
  return 'INTERNAL_ERROR';
}

function isHostInvokeResult<T>(value: unknown): value is HostInvokeResult<T> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true && 'data' in record) return true;
  if (record.ok === false && typeof record.error === 'object' && record.error !== null) {
    const err = record.error as Record<string, unknown>;
    return typeof err.code === 'string' && typeof err.message === 'string';
  }
  return false;
}

function isHealthResponse(value: unknown): value is ConnectScriptHealthResponse {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.ok === true &&
    record.hostKind === 'connect-script' &&
    typeof record.protocolVersion === 'string'
  );
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function probeLocalConnectHealth(
  port: number = CONNECT_SCRIPT_DEFAULT_PORT,
  options?: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number },
): Promise<ConnectScriptHealthResponse | null> {
  const validPort = normalizePort(port);
  if (validPort === null) return null;
  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') return null;

  try {
    const response = await fetchWithTimeout(
      fetchFn,
      `${buildBaseUrl(validPort)}${CONNECT_SCRIPT_ENDPOINTS.HEALTH}`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      options?.timeoutMs ?? 3_000,
      options?.signal,
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    return isHealthResponse(payload) ? payload : null;
  } catch {
    return null;
  }
}

type EventSubscription = {
  capability: string;
  event: string;
  callback: (payload: unknown) => void;
};

/**
 * Create a standalone `UniversalHostBridge` backed by a local Connect Script server.
 * The pairing token is captured privately inside the closure and never persisted to web storage.
 */
export function createLocalConnectBridge(config: LocalConnectBridgeConfig): LocalConnectBridgeHandle {
  const port = normalizePort(config.port);
  if (port === null) {
    throw new RangeError(`Invalid local Connect Script port: ${String(config.port)}`);
  }
  const token = config.token.trim();
  if (!token) {
    throw new Error('A non-empty pairing token is required to create a local Connect Script bridge.');
  }

  const baseUrl = buildBaseUrl(port);
  const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const interactiveTimeoutMs =
    config.interactiveTimeoutMs ?? Math.max(timeoutMs, DEFAULT_INTERACTIVE_INVOKE_TIMEOUT_MS);
  const getFetch = (): typeof fetch => config.fetchImpl ?? globalThis.fetch;

  let disposed = false;
  const subscriptions = new Set<EventSubscription>();
  let sseController: AbortController | null = null;

  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      [CONNECT_SCRIPT_TOKEN_HEADER]: token,
      ...extra,
    };
  }

  function dispatchEventBlock(block: string): void {
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    let parsed: ConnectScriptEventMessage;
    try {
      parsed = JSON.parse(dataLines.join('\n')) as ConnectScriptEventMessage;
    } catch {
      return;
    }
    if (!parsed || typeof parsed.capability !== 'string' || typeof parsed.event !== 'string') {
      return;
    }
    for (const sub of subscriptions) {
      if (sub.capability === parsed.capability && sub.event === parsed.event) {
        try {
          sub.callback(parsed.payload);
        } catch {
          // Keep other subscribers healthy if one consumer throws.
        }
      }
    }
  }

  function stopEventStream(): void {
    if (sseController) {
      sseController.abort();
      sseController = null;
    }
  }

  function ensureEventStream(): void {
    if (disposed || sseController || subscriptions.size === 0) return;
    const fetchFn = getFetch();
    if (typeof fetchFn !== 'function') return;

    const controller = new AbortController();
    sseController = controller;

    void (async () => {
      try {
        const response = await fetchFn(`${baseUrl}${CONNECT_SCRIPT_ENDPOINTS.EVENTS}`, {
          method: 'GET',
          headers: authHeaders({ Accept: 'text/event-stream' }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!controller.signal.aborted && !disposed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            dispatchEventBlock(block);
            boundary = buffer.indexOf('\n\n');
          }
        }
        if (buffer.trim()) {
          dispatchEventBlock(buffer);
        }
      } catch {
        // Stream ended or aborted; caller stays resilient without unhandled rejections.
      } finally {
        if (sseController === controller) {
          sseController = null;
        }
      }
    })();
  }

  return {
    hostKind: 'connect-script',
    port,
    baseUrl,

    async info(): Promise<HostRuntimeInfo> {
      const response = await fetchWithTimeout(
        getFetch(),
        `${baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INFO}`,
        { method: 'GET', headers: authHeaders({ Accept: 'application/json' }) },
        timeoutMs,
      );
      if (!response.ok) {
        const err = new Error(`Connect Script /v1/info failed with HTTP ${response.status}`);
        (err as Error & { status?: number }).status = response.status;
        throw err;
      }
      return (await response.json()) as HostRuntimeInfo;
    },

    async capabilities(): Promise<HostCapabilityDescriptor[]> {
      const response = await fetchWithTimeout(
        getFetch(),
        `${baseUrl}${CONNECT_SCRIPT_ENDPOINTS.CAPABILITIES}`,
        { method: 'GET', headers: authHeaders({ Accept: 'application/json' }) },
        timeoutMs,
      );
      if (!response.ok) {
        const err = new Error(`Connect Script /v1/capabilities failed with HTTP ${response.status}`);
        (err as Error & { status?: number }).status = response.status;
        throw err;
      }
      const data = (await response.json()) as unknown;
      return Array.isArray(data) ? (data as HostCapabilityDescriptor[]) : [];
    },

    async invoke<T = unknown>(
      capability: string,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<HostInvokeResult<T>> {
      if (disposed) {
        return hostErr('UNSUPPORTED', 'Local Connect Script bridge has been disconnected.');
      }
      const body: ConnectScriptInvokeRequest = params
        ? { capability, method, params }
        : { capability, method };

      const effectiveTimeoutMs = isInteractiveInvoke(capability, method)
        ? interactiveTimeoutMs
        : timeoutMs;

      try {
        const response = await fetchWithTimeout(
          getFetch(),
          `${baseUrl}${CONNECT_SCRIPT_ENDPOINTS.INVOKE}`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
              Accept: 'application/json',
            }),
            body: JSON.stringify(body),
          },
          effectiveTimeoutMs,
        );

        const payload = (await response.json().catch(() => null)) as unknown;
        if (isHostInvokeResult<T>(payload)) {
          return payload;
        }

        if (!response.ok) {
          return hostErr(
            mapHttpStatusToErrorCode(response.status),
            `Local helper request failed (HTTP ${response.status}).`,
          );
        }

        return hostErr('INTERNAL_ERROR', 'Unexpected response format from local helper.');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return hostErr('TIMEOUT', 'Local helper request timed out.');
        }
        if (error instanceof Error && error.name === 'AbortError') {
          return hostErr('TIMEOUT', 'Local helper request timed out.');
        }
        return hostErr(
          'INTERNAL_ERROR',
          error instanceof Error ? error.message : 'Could not reach local helper.',
        );
      }
    },

    subscribe(capability: string, event: string, callback: (payload: unknown) => void): () => void {
      if (disposed) return () => {};
      const entry: EventSubscription = { capability, event, callback };
      subscriptions.add(entry);
      ensureEventStream();
      return () => {
        subscriptions.delete(entry);
        if (subscriptions.size === 0) {
          stopEventStream();
        }
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      subscriptions.clear();
      stopEventStream();
    },
  };
}

export type LocalConnectAutoPairState = {
  pairing: boolean;
  error: string | null;
  succeeded: boolean;
};

// In-memory active Web Connect Script bridge (never persisted to browser storage).
let activeBridge: LocalConnectBridgeHandle | null = null;
let activeInfo: HostRuntimeInfo | null = null;
let bridgeRevision = 0;
let autoPairState: LocalConnectAutoPairState = {
  pairing: false,
  error: null,
  succeeded: false,
};
let inFlightAutoPair: Promise<ConnectLocalBridgeResult | null> | null = null;
const bridgeListeners = new Set<() => void>();

let bridgeGeneration = 0;

export function getLocalConnectAutoPairState(): LocalConnectAutoPairState {
  return autoPairState;
}

function notifyBridgeListeners(): void {
  bridgeRevision += 1;
  for (const listener of bridgeListeners) {
    try {
      listener();
    } catch {
      // Isolate listener errors so all subscribers receive updates.
    }
  }
}

export function getLocalConnectBridge(): LocalConnectBridgeHandle | undefined {
  return activeBridge ?? undefined;
}

export function getLocalConnectStatus(): LocalConnectStatus {
  return {
    connected: activeBridge !== null,
    port: activeBridge?.port ?? null,
    info: activeInfo,
  };
}

export function getLocalConnectBridgeRevision(): number {
  return bridgeRevision;
}

export function subscribeLocalConnectBridge(listener: () => void): () => void {
  bridgeListeners.add(listener);
  return () => {
    bridgeListeners.delete(listener);
  };
}

export function attachLocalConnectBridge(
  bridge: LocalConnectBridgeHandle,
  info: HostRuntimeInfo | null = null,
): void {
  if (activeBridge && activeBridge !== bridge) {
    activeBridge.dispose();
  }
  activeBridge = bridge;
  activeInfo = info;
  notifyBridgeListeners();
}

export function disconnectLocalConnectBridge(): void {
  bridgeGeneration += 1;
  const hadAutoPairState = autoPairState.pairing || autoPairState.error !== null || autoPairState.succeeded;
  if (!activeBridge && !activeInfo && !hadAutoPairState) return;
  const previous = activeBridge;
  activeBridge = null;
  activeInfo = null;
  autoPairState = { pairing: false, error: null, succeeded: false };
  inFlightAutoPair = null;
  previous?.dispose();
  notifyBridgeListeners();
}

export type ConsumedStudioPairingHash = {
  port: number;
  token: string;
};

/**
 * Reads `#connect_port=<port>&connect_token=<token>` generated by
 * `scripts/connect-local-agent.mjs --serve`, immediately scrubs both parameters
 * from the URL via `history.replaceState` so the pairing token never lingers in
 * the address bar or session history, and returns the parsed pair (or null).
 */
export function consumeStudioPairingHash(
  loc: Pick<Location, 'pathname' | 'search' | 'hash'> | undefined = typeof window !== 'undefined'
    ? window.location
    : undefined,
  hist: Pick<History, 'state' | 'replaceState'> | undefined = typeof window !== 'undefined'
    ? window.history
    : undefined,
): ConsumedStudioPairingHash | null {
  if (!loc || !loc.hash) return null;
  const rawHash = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash;
  if (!rawHash) return null;

  const params = new URLSearchParams(rawHash);
  const hasPort = params.has('connect_port');
  const hasToken = params.has('connect_token');
  if (!hasPort && !hasToken) {
    return null;
  }

  const rawPort = params.get('connect_port')?.trim() ?? '';
  const rawToken = params.get('connect_token')?.trim() ?? '';

  // Always scrub pairing parameters from URL hash immediately, even if invalid.
  params.delete('connect_port');
  params.delete('connect_token');
  const remainingHash = params.toString();
  const nextUrl = `${loc.pathname}${loc.search}${remainingHash ? `#${remainingHash}` : ''}`;
  try {
    hist?.replaceState(hist.state, '', nextUrl);
  } catch {
    // Ignore restricted history API environments.
  }

  if (!/^\d+$/.test(rawPort) || !rawToken) {
    return null;
  }
  const port = normalizePort(Number.parseInt(rawPort, 10));
  if (port === null) {
    return null;
  }

  return { port, token: rawToken };
}

/**
 * Idempotent, StrictMode-safe module-level auto-pairing bootstrap.
 * Consumes `#connect_port=...&connect_token=...` from `window.location.hash`
 * on ANY route, immediately scrubs the URL, and connects the in-memory loopback
 * bridge once. Safe to call both at app startup (`main.tsx`) and on component mount.
 */
export function bootstrapStudioPairingFromHash(options?: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ConnectLocalBridgeResult | null> {
  if (inFlightAutoPair) {
    return inFlightAutoPair;
  }
  if (typeof window === 'undefined') {
    return Promise.resolve(null);
  }
  const hasDesktopBridge =
    typeof (window as Window & { __OPENMOTION_HOST__?: unknown }).__OPENMOTION_HOST__ === 'object' &&
    (window as Window & { __OPENMOTION_HOST__?: unknown }).__OPENMOTION_HOST__ !== null;

  // Always scrub pairing hash even if desktop bridge or another helper is already connected,
  // so pairing tokens never linger in the address bar or browser history.
  const consumed = consumeStudioPairingHash();
  if (!consumed || hasDesktopBridge || activeBridge !== null) {
    return Promise.resolve(null);
  }

  autoPairState = { pairing: true, error: null, succeeded: false };
  notifyBridgeListeners();
  const generation = bridgeGeneration;

  const promise = connectLocalConnectBridge({
    port: consumed.port,
    token: consumed.token,
    fetchImpl: options?.fetchImpl,
    timeoutMs: options?.timeoutMs,
  })
    .then(result => {
      if (generation !== bridgeGeneration) {
        if (result.ok) {
          result.bridge.dispose();
        }
        return {
          ok: false as const,
          error: { code: 'USER_DENIED' as const, message: 'Local helper pairing was disconnected.' },
        };
      }
      if (result.ok) {
        autoPairState = { pairing: false, error: null, succeeded: true };
      } else {
        autoPairState = { pairing: false, error: result.error.message, succeeded: false };
      }
      notifyBridgeListeners();
      return result;
    })
    .catch(error => {
      if (generation !== bridgeGeneration) {
        return {
          ok: false as const,
          error: { code: 'USER_DENIED' as const, message: 'Local helper pairing was disconnected.' },
        };
      }
      const message = error instanceof Error ? error.message : 'Could not connect to the local helper.';
      autoPairState = { pairing: false, error: message, succeeded: false };
      notifyBridgeListeners();
      return { ok: false as const, error: { code: 'INTERNAL_ERROR' as const, message } };
    })
    .finally(() => {
      if (inFlightAutoPair === promise) {
        inFlightAutoPair = null;
      }
    });

  inFlightAutoPair = promise;
  return promise;
}

/**
 * Probe `/v1/health`, verify pairing token via `/v1/info` & `/v1/capabilities`,
 * and attach the active bridge in memory on success.
 */
export async function connectLocalConnectBridge(
  config: LocalConnectBridgeConfig,
): Promise<ConnectLocalBridgeResult> {
  const generation = bridgeGeneration;
  const port = normalizePort(config.port);
  if (port === null) {
    return {
      ok: false,
      error: { code: 'INVALID_PARAMS', message: 'Enter a valid local port between 1 and 65535.' },
    };
  }
  const token = config.token.trim();
  if (!token) {
    return {
      ok: false,
      error: { code: 'INVALID_PARAMS', message: 'Enter the pairing token shown by the local helper.' },
    };
  }

  const health = await probeLocalConnectHealth(port, {
    fetchImpl: config.fetchImpl,
    timeoutMs: config.timeoutMs ?? 3_000,
  });
  if (!health) {
    return {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: `No OpenMotion local helper is listening on 127.0.0.1:${port}.`,
      },
    };
  }

  const bridge = createLocalConnectBridge({
    port,
    token,
    fetchImpl: config.fetchImpl,
    timeoutMs: config.timeoutMs,
  });

  try {
    const [info, capabilities] = await Promise.all([bridge.info(), bridge.capabilities()]);
    if (generation !== bridgeGeneration) {
      bridge.dispose();
      return {
        ok: false,
        error: { code: 'USER_DENIED', message: 'Local helper pairing was disconnected.' },
      };
    }
    attachLocalConnectBridge(bridge, info);
    return { ok: true, bridge, info, capabilities };
  } catch (error) {
    bridge.dispose();
    const status = (error as Error & { status?: number })?.status;
    const code: HostErrorCode =
      typeof status === 'number' ? mapHttpStatusToErrorCode(status) : 'INTERNAL_ERROR';
    const message =
      code === 'UNAUTHORIZED'
        ? 'Pairing token was rejected. Copy the current token from your terminal and try again.'
        : code === 'ORIGIN_DENIED'
          ? 'This page origin is not allowed by the local helper.'
          : error instanceof Error
            ? error.message
            : 'Could not connect to the local helper.';
    return { ok: false, error: { code, message } };
  }
}
