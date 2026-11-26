/**
 * K3 — Desktop System-Browser Session Handoff Manager (PKCE S256 + Loopback).
 *
 * Implements the desktop side of the C1 <-> K3 browser session handoff contract
 * (`shared/desktop-auth-handoff.ts`):
 * 1. Generates PKCE S256 (`codeVerifier` / `codeChallenge`) and CSPRNG `state`.
 * 2. Binds an ephemeral loopback HTTP listener on `127.0.0.1:0` and validates
 *    the redirect URI via `isValidDesktopLoopbackRedirectUri`.
 * 3. Opens the system browser at `${studioOrigin}/auth/desktop/start?...`.
 * 4. Validates callback `state` in constant time, replies with a static
 *    no-script completion page, closes the loopback server, and posts
 *    `{ code, codeVerifier, redirectUri }` to `${studioOrigin}/auth/desktop/exchange`
 *    using the injected `exchangeFetch` (in Electron main process,
 *    `mainWindow.webContents.session.fetch`) so the `om_session` cookie lands
 *    directly in the main window's cookie jar.
 * 5. Supports cancellation, timeout cleanup, state subscriptions, and
 *    in-window fallback URL generation (`${studioOrigin}/auth/login`).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DESKTOP_HANDOFF_EXCHANGE_PATH,
  DESKTOP_HANDOFF_START_PATH,
  isValidDesktopLoopbackRedirectUri,
  normalizeDesktopHandoffPlanTier,
  type DesktopHandoffExchangeRequest,
  type DesktopHandoffExchangeResponse,
  type DesktopHandoffPlanTier,
} from '../../shared/desktop-auth-handoff.ts';

export const DEFAULT_DESKTOP_HANDOFF_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_DESKTOP_EXCHANGE_TIMEOUT_MS = 15 * 1000;
export const DEFAULT_DESKTOP_CALLBACK_PATH = '/callback' as const;
export const DEFAULT_DESKTOP_PRICING_URL_PROD = 'https://open-design.ai/pricing' as const;
export const DEFAULT_DESKTOP_PRICING_URL_TEST = 'https://open-design.powerformer.net/pricing' as const;

const ALLOWED_DESKTOP_PRICING_HOSTS = [
  'open-design.ai',
  'open-design.powerformer.net',
  'vela-api.powerformer.net',
] as const;

const ALLOWED_DESKTOP_PRICING_PATH_PREFIXES = [
  '/pricing',
  '/plans',
  '/zh/pricing',
  '/api/auth/one-tap/handoff',
] as const;

/**
 * Validates and resolves the allowlisted Pricing redirect URL for desktop loopback handoff.
 * Returns `null` if an explicit candidate is outside the allowlist so the manager safely
 * falls back to the static 200 completion HTML instead of redirecting to an untrusted URL.
 */
export function resolveSafeDesktopPricingUrl(
  candidate: string | undefined,
  studioOrigin: string,
): string | null {
  let rawTarget = candidate?.trim();
  if (!rawTarget) {
    try {
      const studioHost = new URL(studioOrigin).hostname.toLowerCase().replace(/\.$/, '');
      rawTarget =
        studioHost === 'powerformer.net' || studioHost.endsWith('.powerformer.net')
          ? DEFAULT_DESKTOP_PRICING_URL_TEST
          : DEFAULT_DESKTOP_PRICING_URL_PROD;
    } catch {
      rawTarget = DEFAULT_DESKTOP_PRICING_URL_PROD;
    }
  }
  if (/[\x00-\x1f\x7f]/.test(rawTarget)) return null;
  try {
    const parsed = new URL(rawTarget);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const hostAllowed = ALLOWED_DESKTOP_PRICING_HOSTS.some(
      domain => host === domain || host.endsWith(`.${domain}`),
    );
    if (!hostAllowed) return null;
    const normalizedPath = parsed.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    const pathAllowed = ALLOWED_DESKTOP_PRICING_PATH_PREFIXES.some(
      prefix => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`),
    );
    if (!pathAllowed) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export type DesktopAuthHandoffStatus =
  | 'idle'
  | 'pending'
  | 'exchanging'
  | 'authenticated'
  | 'canceled'
  | 'error';

export type DesktopAuthHandoffState = {
  status: DesktopAuthHandoffStatus;
  startedAt?: string;
  completedAt?: string;
  startUrl?: string;
  redirectUri?: string;
  user?: DesktopHandoffExchangeResponse['user'];
  workspaceId?: string;
  planTier?: DesktopHandoffPlanTier;
  interactiveLogin?: boolean;
  errorCode?: string;
  errorMessage?: string;
};

export type DesktopAuthExchangeInit = {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  credentials?: 'include' | 'same-origin' | 'omit';
  signal?: AbortSignal;
};

export type DesktopHandoffProbeFetch = (
  url: string,
  init: { method: 'GET'; redirect: 'manual'; signal?: AbortSignal },
) => Promise<{ status: number }>;

export function sanitizeAuthReturnPath(rawPath: string | null | undefined): string | undefined {
  if (typeof rawPath !== 'string') return undefined;
  const trimmed = rawPath.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return undefined;
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return undefined;
  if (trimmed === '/auth' || trimmed.startsWith('/auth/')) return undefined;
  return trimmed;
}

export function parseStudioAuthNavigationUrl(
  rawUrl: string,
  studioOrigin: string,
): { returnPath?: string; switchAccount: boolean } | null {
  try {
    const parsed = new URL(rawUrl);
    const expectedOrigin = new URL(studioOrigin).origin;
    if (parsed.origin !== expectedOrigin) return null;
    const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
    if (normalizedPath !== '/auth/login') return null;
    const returnPath = sanitizeAuthReturnPath(parsed.searchParams.get('returnTo'));
    const switchAccount = parsed.searchParams.get('switch') === '1';
    return {
      ...(returnPath ? { returnPath } : {}),
      switchAccount,
    };
  } catch {
    return null;
  }
}

export interface ElectronSessionDeliveryTarget {
  isDestroyed(): boolean;
  webContents: {
    session: {
      cookies: {
        flushStore(): Promise<void>;
        get(filter: { url: string; name: string }): Promise<Array<{ value?: string }>>;
      };
      fetch(
        url: string,
        init: { method: 'GET'; credentials: 'include' },
      ): Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    };
  };
}

/**
 * Verifies that the Electron BrowserWindow session actually holds the newly exchanged `om_session`
 * for the exact `user.id` and `workspaceId` returned by `/auth/desktop/exchange` (rejecting stale
 * Account A cookies that failed to be overwritten during Account B sign-in).
 */
export async function verifyElectronSessionDelivered(
  getWindow: () => ElectronSessionDeliveryTarget | null,
  context: {
    studioOrigin: string;
    user: DesktopHandoffExchangeResponse['user'];
    workspaceId: string;
  },
): Promise<boolean> {
  const win = getWindow();
  if (!win || win.isDestroyed()) return false;
  await win.webContents.session.cookies.flushStore().catch(() => {});
  if (win.isDestroyed()) return false;
  const cookies = await win.webContents.session.cookies.get({
    url: context.studioOrigin,
    name: 'om_session',
  });
  if (win.isDestroyed() || !cookies.some(cookie => Boolean(cookie.value))) {
    return false;
  }
  const meUrl = new URL('/auth/me', context.studioOrigin).toString();
  const meRes = await win.webContents.session.fetch(meUrl, {
    method: 'GET',
    credentials: 'include',
  });
  if (win.isDestroyed() || !meRes.ok) {
    return false;
  }
  const meBody = (await meRes.json().catch(() => null)) as {
    authenticated?: unknown;
    user?: { id?: unknown };
    activeWorkspaceId?: unknown;
  } | null;
  return (
    !win.isDestroyed() &&
    meBody?.authenticated === true &&
    meBody.user?.id === context.user.id &&
    meBody.activeWorkspaceId === context.workspaceId
  );
}

/**
 * Probes whether the target Studio origin has mounted `GET /auth/desktop/start`.
 * Mounted servers validate query params and return HTTP 400 (no side effects).
 * Older servers without desktop handoff routes return 404/405/501.
 */
export async function probeDesktopHandoffSupport(
  studioOrigin: string,
  fetchImpl: DesktopHandoffProbeFetch,
  options?: { timeoutMs?: number },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? 2500;
  const probeUrl = new URL(DESKTOP_HANDOFF_START_PATH, studioOrigin).toString();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const res = await fetchImpl(probeUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: abortController.signal,
    });
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return false;
    }
    return true;
  } catch {
    // Do not downgrade on transient network/timeout errors.
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export type DesktopAuthExchangeResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
};

export type DesktopAuthExchangeFetch = (
  url: string,
  init: DesktopAuthExchangeInit,
) => Promise<DesktopAuthExchangeResponseLike>;

export type DesktopAuthHandoffManagerOptions = {
  /** Base Studio origin, e.g. "https://motion.open-design.ai". Optional when `getStudioOrigin` is supplied. */
  studioOrigin?: string;
  /** Dynamic resolver for the active Studio origin (follows signed config updates). */
  getStudioOrigin?: () => string;
  /** Opens the handoff start URL in the user's system browser. */
  openExternal: (url: string) => Promise<void> | void;
  /**
   * Performs the POST `/auth/desktop/exchange` call.
   * In Electron main process, pass `mainWindow.webContents.session.fetch`
   * so `Set-Cookie: om_session=...` writes directly to the main window session.
   */
  exchangeFetch: DesktopAuthExchangeFetch;
  /** Maximum time to wait for loopback callback (default: 5 minutes). */
  timeoutMs?: number;
  /** Maximum time to wait for POST `/auth/desktop/exchange` (default: 15 seconds). */
  exchangeTimeoutMs?: number;
  /** Path served on the loopback server (default: "/callback"). */
  callbackPath?: string;
  /** Optional explicit Pricing URL for interactive Free/Go 302 redirect (validated against allowlist). */
  pricingUrl?: string;
  /** Optional dynamic resolver for Pricing URL (validated against allowlist). */
  getPricingUrl?: () => string | undefined;
  /**
   * Optional verification hook invoked after `/auth/desktop/exchange` returns 200 to confirm
   * the main Electron window is still alive and `om_session` is persisted in its session store
   * before sending the loopback HTTP response (200 or 302).
   */
  verifySessionDelivered?: (context: {
    studioOrigin: string;
    user: DesktopHandoffExchangeResponse['user'];
    workspaceId: string;
  }) => Promise<boolean> | boolean;
  /** Optional callback invoked after authentication completes to focus main window. */
  onFocusMainWindow?: () => void;
};

export type StartDesktopLoginOptions = {
  /** Adds `switch=1` to force account selection in the browser. */
  switchAccount?: boolean;
};

export type StartedDesktopLogin = {
  startUrl: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** Resolves with the final state once login authenticates, cancels, times out, or errors. */
  completion: Promise<DesktopAuthHandoffState>;
};

type ActiveAttempt = {
  id: number;
  startedAt: string;
  studioOrigin: string;
  codeVerifier: string;
  expectedState: string;
  redirectUri: string;
  server: Server;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  exchangeAbort: AbortController | null;
  pendingResponse: ServerResponse | null;
  responseEnded: boolean;
  consumed: boolean;
  settled: boolean;
  canceled: boolean;
  resolveCompletion: (state: DesktopAuthHandoffState) => void;
};

const CALLBACK_SUCCESS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OpenDesign Sign-In</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #ffffff;
        --panel: #fafafa;
        --border: #dbdbdb;
        --text: #202020;
        --muted: #5c5c5c;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #191a1b;
          --panel: #202123;
          --border: #484b4d;
          --text: #f7f8f5;
          --muted: #c0c4bd;
        }
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--bg);
        color: var(--text);
        font-family: "Albert Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
      }
      main {
        max-width: 440px;
        padding: 28px 32px;
        border-radius: 12px;
        background: var(--panel);
        border: 1px solid var(--border);
        text-align: center;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 18px;
        font-weight: 600;
      }
      p {
        margin: 0;
        font-size: 14px;
        line-height: 1.5;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Sign-in complete</h1>
      <p>Sign-in complete — you can close this tab and return to OpenDesign.</p>
    </main>
  </body>
</html>
`;

const CALLBACK_ERROR_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OpenDesign Sign-In Error</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #ffffff;
        --panel: #fafafa;
        --border: #dbdbdb;
        --text: #202020;
        --muted: #5c5c5c;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #191a1b;
          --panel: #202123;
          --border: #484b4d;
          --text: #f7f8f5;
          --muted: #c0c4bd;
        }
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--bg);
        color: var(--text);
        font-family: "Albert Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
      }
      main {
        max-width: 440px;
        padding: 28px 32px;
        border-radius: 12px;
        background: var(--panel);
        border: 1px solid var(--border);
        text-align: center;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 18px;
        font-weight: 600;
      }
      p {
        margin: 0;
        font-size: 14px;
        line-height: 1.5;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Sign-in verification failed</h1>
      <p>Could not verify this sign-in callback. You can close this tab and retry in OpenDesign.</p>
    </main>
  </body>
</html>
`;

const STATIC_HTML_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  'x-content-type-options': 'nosniff',
  connection: 'close',
};

/** Generates a 43-char RFC 7636 PKCE code verifier using Node CSPRNG. */
export function generatePkceVerifier(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/** Derives an RFC 7636 S256 PKCE code challenge from `codeVerifier`. */
export function derivePkceChallengeS256(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

/** Generates a random opaque CSRF state token. */
export function generateHandoffState(byteLength = 24): string {
  return randomBytes(byteLength).toString('base64url');
}

/** Compares two UTF-8 strings in constant time when lengths match. */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  if (bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

function normalizeStudioOrigin(rawOrigin: string): string {
  const parsed = new URL(rawOrigin);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported studioOrigin protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('studioOrigin must not include embedded credentials');
  }
  return parsed.origin;
}

function isValidExchangeResponse(payload: unknown): payload is DesktopHandoffExchangeResponse {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Record<string, unknown>;
  if (candidate.ok !== true) return false;
  if (typeof candidate.workspaceId !== 'string' || !candidate.workspaceId) return false;
  const user = candidate.user as Record<string, unknown> | undefined;
  if (!user || typeof user !== 'object' || typeof user.id !== 'string' || !user.id) {
    return false;
  }
  return true;
}

function closeServerPromptly(server: Server): void {
  try {
    server.close();
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  } catch {
    // Ignore close errors on already-closed servers.
  }
}

function closeServerAfterResponse(server: Server): void {
  try {
    server.close();
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  } catch {
    // Ignore close errors on already-closed servers.
  }
}

function createAbortError(message = 'Session exchange timed out.'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function runWithAbort<T>(work: () => Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(work)
      .then(
        value => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        error => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
  });
}

export class DesktopAuthHandoffManager {
  private readonly staticStudioOrigin?: string;
  private readonly getStudioOriginFn?: () => string;
  private readonly openExternal: (url: string) => Promise<void> | void;
  private readonly exchangeFetch: DesktopAuthExchangeFetch;
  private readonly timeoutMs: number;
  private readonly exchangeTimeoutMs: number;
  private readonly callbackPath: string;
  private readonly staticPricingUrl?: string;
  private readonly getPricingUrlFn?: () => string | undefined;
  private readonly verifySessionDelivered?: (context: {
    studioOrigin: string;
    user: DesktopHandoffExchangeResponse['user'];
    workspaceId: string;
  }) => Promise<boolean> | boolean;
  private readonly onFocusMainWindow?: () => void;

  private state: DesktopAuthHandoffState = { status: 'idle' };
  private readonly listeners = new Set<(state: DesktopAuthHandoffState) => void>();
  private activeAttempt: ActiveAttempt | null = null;
  private nextAttemptId = 1;

  constructor(options: DesktopAuthHandoffManagerOptions) {
    if (!options.getStudioOrigin && !options.studioOrigin) {
      throw new Error('DesktopAuthHandoffManager requires studioOrigin or getStudioOrigin');
    }
    this.staticStudioOrigin = options.studioOrigin ? normalizeStudioOrigin(options.studioOrigin) : undefined;
    this.getStudioOriginFn = options.getStudioOrigin;
    this.openExternal = options.openExternal;
    this.exchangeFetch = options.exchangeFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DESKTOP_HANDOFF_TIMEOUT_MS;
    this.exchangeTimeoutMs = options.exchangeTimeoutMs ?? DEFAULT_DESKTOP_EXCHANGE_TIMEOUT_MS;
    const rawPath = options.callbackPath?.trim() || DEFAULT_DESKTOP_CALLBACK_PATH;
    this.callbackPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    this.staticPricingUrl = options.pricingUrl;
    this.getPricingUrlFn = options.getPricingUrl;
    this.verifySessionDelivered = options.verifySessionDelivered;
    this.onFocusMainWindow = options.onFocusMainWindow;
  }

  private resolveCurrentPricingUrl(): string | undefined {
    if (this.getPricingUrlFn) {
      return this.getPricingUrlFn();
    }
    return this.staticPricingUrl;
  }

  private resolveCurrentStudioOrigin(): string {
    if (this.getStudioOriginFn) {
      return normalizeStudioOrigin(this.getStudioOriginFn());
    }
    return this.staticStudioOrigin!;
  }

  getState(): DesktopAuthHandoffState {
    return { ...this.state };
  }

  subscribe(listener: (state: DesktopAuthHandoffState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Returns the Studio in-window login fallback URL (`${studioOrigin}/auth/login`)
   * for environments where system-browser handoff cannot complete.
   */
  openInWindowFallback(options?: { returnPath?: string; switchAccount?: boolean }): string {
    const url = new URL('/auth/login', this.resolveCurrentStudioOrigin());
    if (options?.switchAccount) {
      url.searchParams.set('switch', '1');
    }
    const safeReturnPath = sanitizeAuthReturnPath(options?.returnPath);
    if (safeReturnPath) {
      url.searchParams.set('returnTo', safeReturnPath);
    }
    return url.toString();
  }

  private emitState(next: DesktopAuthHandoffState): void {
    this.state = { ...next };
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Never allow subscriber errors to disrupt auth state machine.
      }
    }
  }

  private respondOnceAndClose(
    attempt: ActiveAttempt,
    write: (res: ServerResponse, onDone: () => void) => void,
    options?: { closePromptly?: boolean },
  ): void {
    if (attempt.responseEnded) return;
    attempt.responseEnded = true;
    const res = attempt.pendingResponse;
    attempt.pendingResponse = null;
    const closeFn = options?.closePromptly ? closeServerPromptly : closeServerAfterResponse;
    if (!res || res.writableEnded || res.destroyed) {
      closeFn(attempt.server);
      return;
    }
    try {
      write(res, () => {
        closeFn(attempt.server);
      });
    } catch {
      closeFn(attempt.server);
    }
  }

  private respondErrorAndClose(
    attempt: ActiveAttempt,
    statusCode: 502 | 503 | 504,
    options?: { closePromptly?: boolean },
  ): void {
    this.respondOnceAndClose(
      attempt,
      (res, onDone) => {
        res.writeHead(statusCode, STATIC_HTML_HEADERS);
        res.end(CALLBACK_ERROR_HTML, onDone);
      },
      options,
    );
  }

  private cleanupAttempt(attempt: ActiveAttempt): void {
    if (attempt.timeoutTimer) {
      clearTimeout(attempt.timeoutTimer);
      attempt.timeoutTimer = null;
    }
    if (attempt.exchangeAbort) {
      attempt.exchangeAbort.abort();
      attempt.exchangeAbort = null;
    }
    if (attempt.pendingResponse && !attempt.responseEnded) {
      this.respondErrorAndClose(attempt, 503, { closePromptly: true });
    } else {
      closeServerPromptly(attempt.server);
    }
    if (this.activeAttempt === attempt) {
      this.activeAttempt = null;
    }
  }

  private settleAttempt(attempt: ActiveAttempt, nextState: DesktopAuthHandoffState): void {
    if (attempt.settled) return;
    attempt.settled = true;
    if (attempt.timeoutTimer) {
      clearTimeout(attempt.timeoutTimer);
      attempt.timeoutTimer = null;
    }
    if (this.activeAttempt === attempt) {
      this.activeAttempt = null;
    }
    this.emitState(nextState);
    attempt.resolveCompletion(this.getState());
  }

  private buildStartUrl(input: {
    studioOrigin: string;
    codeChallenge: string;
    redirectUri: string;
    state: string;
    switchAccount?: boolean;
  }): string {
    const url = new URL(DESKTOP_HANDOFF_START_PATH, input.studioOrigin);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    if (input.switchAccount) {
      url.searchParams.set('switch', '1');
    }
    return url.toString();
  }

  private async listenLoopback(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ server: Server; redirectUri: string }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });

    const address = server.address() as AddressInfo | null;
    if (!address || typeof address === 'string' || !Number.isInteger(address.port)) {
      closeServerPromptly(server);
      throw new Error('Failed to bind ephemeral loopback port');
    }

    const redirectUri = `http://127.0.0.1:${address.port}${this.callbackPath}`;
    if (!isValidDesktopLoopbackRedirectUri(redirectUri)) {
      closeServerPromptly(server);
      throw new Error(`Invalid desktop loopback redirect URI: ${redirectUri}`);
    }

    return { server, redirectUri };
  }

  /**
   * Starts a fresh PKCE S256 system-browser sign-in handoff.
   * Cancels any previous in-flight attempt first.
   */
  async startLogin(options?: StartDesktopLoginOptions): Promise<StartedDesktopLogin> {
    if (this.activeAttempt) {
      this.cancelLogin();
    }

    const attemptId = this.nextAttemptId++;
    const codeVerifier = generatePkceVerifier();
    const codeChallenge = derivePkceChallengeS256(codeVerifier);
    const state = generateHandoffState();
    const startedAt = new Date().toISOString();

    let resolveCompletion!: (finalState: DesktopAuthHandoffState) => void;
    const completion = new Promise<DesktopAuthHandoffState>(resolve => {
      resolveCompletion = resolve;
    });

    let attemptRef: ActiveAttempt | null = null;

    const { server, redirectUri } = await this.listenLoopback((req, res) => {
      if (!attemptRef) {
        res.writeHead(503, STATIC_HTML_HEADERS);
        res.end(CALLBACK_ERROR_HTML);
        return;
      }
      this.handleLoopbackRequest(attemptRef, req, res);
    });

    const attemptOrigin = this.resolveCurrentStudioOrigin();
    const startUrl = this.buildStartUrl({
      studioOrigin: attemptOrigin,
      codeChallenge,
      redirectUri,
      state,
      switchAccount: options?.switchAccount,
    });

    const attempt: ActiveAttempt = {
      id: attemptId,
      startedAt,
      studioOrigin: attemptOrigin,
      codeVerifier,
      expectedState: state,
      redirectUri,
      server,
      timeoutTimer: null,
      exchangeAbort: null,
      pendingResponse: null,
      responseEnded: false,
      consumed: false,
      settled: false,
      canceled: false,
      resolveCompletion,
    };
    attemptRef = attempt;
    this.activeAttempt = attempt;

    attempt.timeoutTimer = setTimeout(() => {
      if (attempt.settled || attempt.consumed) return;
      closeServerPromptly(attempt.server);
      this.settleAttempt(attempt, {
        status: 'error',
        startedAt: attempt.startedAt,
        completedAt: new Date().toISOString(),
        errorCode: 'TIMEOUT',
        errorMessage: 'Sign-in timed out waiting for browser confirmation.',
      });
    }, this.timeoutMs);

    this.emitState({
      status: 'pending',
      startedAt,
      startUrl,
      redirectUri,
    });

    try {
      await this.openExternal(startUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.cleanupAttempt(attempt);
      this.settleAttempt(attempt, {
        status: 'error',
        startedAt,
        completedAt: new Date().toISOString(),
        errorCode: 'OPEN_BROWSER_FAILED',
        errorMessage: message || 'Could not open system browser for sign-in.',
      });
      throw error;
    }

    return {
      startUrl,
      redirectUri,
      state,
      codeChallenge,
      completion,
    };
  }

  /**
   * Cancels an active pending or exchanging login attempt and closes the loopback server.
   */
  cancelLogin(): DesktopAuthHandoffState {
    const attempt = this.activeAttempt;
    if (!attempt || attempt.settled) {
      return this.getState();
    }
    attempt.canceled = true;
    this.cleanupAttempt(attempt);
    this.settleAttempt(attempt, {
      status: 'canceled',
      startedAt: attempt.startedAt,
      completedAt: new Date().toISOString(),
    });
    return this.getState();
  }

  dispose(): void {
    this.cancelLogin();
    this.listeners.clear();
  }

  private handleLoopbackRequest(
    attempt: ActiveAttempt,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method !== 'GET' || parsedUrl.pathname !== this.callbackPath) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
      res.end('Not Found');
      return;
    }

    if (attempt.consumed || attempt.settled || attempt.canceled) {
      res.writeHead(409, STATIC_HTML_HEADERS);
      res.end(CALLBACK_ERROR_HTML);
      return;
    }

    const callbackError = parsedUrl.searchParams.get('error');
    if (callbackError) {
      attempt.consumed = true;
      res.writeHead(400, STATIC_HTML_HEADERS);
      res.end(CALLBACK_ERROR_HTML, () => {
        closeServerAfterResponse(attempt.server);
      });
      this.settleAttempt(attempt, {
        status: 'error',
        startedAt: attempt.startedAt,
        completedAt: new Date().toISOString(),
        errorCode: 'AUTH_CALLBACK_ERROR',
        errorMessage: 'Sign-in was rejected or canceled in the browser.',
      });
      return;
    }

    const code = parsedUrl.searchParams.get('code')?.trim() ?? '';
    const returnedState = parsedUrl.searchParams.get('state')?.trim() ?? '';

    if (!returnedState || !timingSafeEqualStrings(returnedState, attempt.expectedState)) {
      // Reject mismatched CSRF state without aborting the legitimate in-flight session.
      res.writeHead(400, STATIC_HTML_HEADERS);
      res.end(CALLBACK_ERROR_HTML);
      return;
    }

    if (!code) {
      res.writeHead(400, STATIC_HTML_HEADERS);
      res.end(CALLBACK_ERROR_HTML);
      return;
    }

    attempt.consumed = true;
    if (attempt.timeoutTimer) {
      clearTimeout(attempt.timeoutTimer);
      attempt.timeoutTimer = null;
    }

    // Suspend the loopback HTTP response until PKCE exchange and Electron session
    // persistence complete (or fail/timeout) before responding once and closing the server.
    attempt.pendingResponse = res;

    void this.performExchange(attempt, code);
  }

  private async performExchange(attempt: ActiveAttempt, code: string): Promise<void> {
    if (attempt.settled || attempt.canceled) {
      this.respondErrorAndClose(attempt, 503);
      return;
    }

    this.emitState({
      status: 'exchanging',
      startedAt: attempt.startedAt,
      redirectUri: attempt.redirectUri,
    });

    const exchangeUrl = new URL(DESKTOP_HANDOFF_EXCHANGE_PATH, attempt.studioOrigin).toString();
    const requestBody: DesktopHandoffExchangeRequest = {
      code,
      codeVerifier: attempt.codeVerifier,
      redirectUri: attempt.redirectUri,
    };

    const abortController = new AbortController();
    attempt.exchangeAbort = abortController;
    const exchangeTimer = setTimeout(() => {
      abortController.abort();
    }, this.exchangeTimeoutMs);

    try {
      const response = await runWithAbort(
        () =>
          this.exchangeFetch(exchangeUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(requestBody),
            credentials: 'include',
            signal: abortController.signal,
          }),
        abortController.signal,
      );

      if (attempt.canceled || attempt.settled) {
        this.respondErrorAndClose(attempt, 503);
        return;
      }

      if (!response.ok) {
        this.respondErrorAndClose(attempt, 502);
        this.settleAttempt(attempt, {
          status: 'error',
          startedAt: attempt.startedAt,
          completedAt: new Date().toISOString(),
          errorCode: 'EXCHANGE_FAILED',
          errorMessage: `Session exchange failed with HTTP ${response.status}.`,
        });
        return;
      }

      let parsedBody: unknown;
      try {
        parsedBody = await runWithAbort(() => response.json(), abortController.signal);
      } catch (jsonErr) {
        const isAbort = jsonErr instanceof Error && jsonErr.name === 'AbortError';
        if (isAbort) throw jsonErr;
        this.respondErrorAndClose(attempt, 502);
        this.settleAttempt(attempt, {
          status: 'error',
          startedAt: attempt.startedAt,
          completedAt: new Date().toISOString(),
          errorCode: 'INVALID_EXCHANGE_RESPONSE',
          errorMessage: 'Session exchange returned invalid JSON.',
        });
        return;
      }

      if (attempt.canceled || attempt.settled) {
        this.respondErrorAndClose(attempt, 503);
        return;
      }

      if (!isValidExchangeResponse(parsedBody)) {
        this.respondErrorAndClose(attempt, 502);
        this.settleAttempt(attempt, {
          status: 'error',
          startedAt: attempt.startedAt,
          completedAt: new Date().toISOString(),
          errorCode: 'INVALID_EXCHANGE_RESPONSE',
          errorMessage: 'Session exchange response missing user or workspace identity.',
        });
        return;
      }

      if (this.verifySessionDelivered) {
        let delivered = false;
        try {
          delivered = await runWithAbort(
            () =>
              this.verifySessionDelivered!({
                studioOrigin: attempt.studioOrigin,
                user: parsedBody.user,
                workspaceId: parsedBody.workspaceId,
              }),
            abortController.signal,
          );
        } catch (verifyErr) {
          const isAbort = verifyErr instanceof Error && verifyErr.name === 'AbortError';
          if (isAbort) throw verifyErr;
          delivered = false;
        }

        if (attempt.canceled || attempt.settled) {
          this.respondErrorAndClose(attempt, 503);
          return;
        }

        if (!delivered) {
          this.respondErrorAndClose(attempt, 503);
          this.settleAttempt(attempt, {
            status: 'error',
            startedAt: attempt.startedAt,
            completedAt: new Date().toISOString(),
            errorCode: 'SESSION_DELIVERY_FAILED',
            errorMessage: 'Could not confirm desktop session cookie delivery.',
          });
          return;
        }
      }

      const planTier = normalizeDesktopHandoffPlanTier(parsedBody.planTier);
      const interactiveLogin = parsedBody.interactiveLogin === true;
      const shouldRedirectPricing =
        interactiveLogin && (planTier === 'free' || planTier === 'go');
      const rawRedirectCandidate =
        parsedBody.pricingHandoffUrl !== undefined
          ? parsedBody.pricingHandoffUrl
          : this.resolveCurrentPricingUrl();
      const safePricingUrl =
        shouldRedirectPricing && rawRedirectCandidate !== null
          ? resolveSafeDesktopPricingUrl(rawRedirectCandidate, attempt.studioOrigin)
          : null;

      if (safePricingUrl) {
        this.respondOnceAndClose(attempt, (res, onDone) => {
          res.writeHead(302, {
            location: safePricingUrl,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            connection: 'close',
          });
          res.end('', onDone);
        });
      } else {
        this.respondOnceAndClose(attempt, (res, onDone) => {
          res.writeHead(200, STATIC_HTML_HEADERS);
          res.end(CALLBACK_SUCCESS_HTML, onDone);
        });
      }

      this.settleAttempt(attempt, {
        status: 'authenticated',
        startedAt: attempt.startedAt,
        completedAt: new Date().toISOString(),
        user: parsedBody.user,
        workspaceId: parsedBody.workspaceId,
        planTier,
        interactiveLogin,
      });

      try {
        this.onFocusMainWindow?.();
      } catch {
        // Ignore window focus errors after successful auth.
      }
    } catch (error) {
      if (attempt.canceled || attempt.settled) {
        this.respondErrorAndClose(attempt, 503);
        return;
      }
      const isAbort = error instanceof Error && error.name === 'AbortError';
      this.respondErrorAndClose(attempt, isAbort ? 504 : 502);
      this.settleAttempt(attempt, {
        status: 'error',
        startedAt: attempt.startedAt,
        completedAt: new Date().toISOString(),
        errorCode: isAbort ? 'EXCHANGE_TIMEOUT' : 'EXCHANGE_NETWORK_ERROR',
        errorMessage: isAbort
          ? 'Session exchange timed out.'
          : error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      clearTimeout(exchangeTimer);
      if (attempt.exchangeAbort === abortController) {
        attempt.exchangeAbort = null;
      }
    }
  }
}
