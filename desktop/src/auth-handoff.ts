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
  type DesktopHandoffExchangeRequest,
  type DesktopHandoffExchangeResponse,
} from '../../shared/desktop-auth-handoff.ts';

export const DEFAULT_DESKTOP_HANDOFF_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_DESKTOP_EXCHANGE_TIMEOUT_MS = 15 * 1000;
export const DEFAULT_DESKTOP_CALLBACK_PATH = '/callback' as const;

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
  if (!trimmed || /[\r\n\0\\]/.test(trimmed)) return undefined;
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return undefined;
  if (trimmed === '/auth' || trimmed.startsWith('/auth/')) return undefined;
  try {
    const resolved = new URL(trimmed, 'https://studio.invalid');
    if (resolved.origin !== 'https://studio.invalid') return undefined;
    if (resolved.pathname === '/auth' || resolved.pathname.startsWith('/auth/')) return undefined;
  } catch {
    return undefined;
  }
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
  server: Server | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  exchangeAbort: AbortController | null;
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

export class DesktopAuthHandoffManager {
  private readonly staticStudioOrigin?: string;
  private readonly getStudioOriginFn?: () => string;
  private readonly openExternal: (url: string) => Promise<void> | void;
  private readonly exchangeFetch: DesktopAuthExchangeFetch;
  private readonly timeoutMs: number;
  private readonly exchangeTimeoutMs: number;
  private readonly callbackPath: string;
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
    this.onFocusMainWindow = options.onFocusMainWindow;
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

  private cleanupAttempt(attempt: ActiveAttempt): void {
    if (attempt.timeoutTimer) {
      clearTimeout(attempt.timeoutTimer);
      attempt.timeoutTimer = null;
    }
    if (attempt.exchangeAbort) {
      attempt.exchangeAbort.abort();
      attempt.exchangeAbort = null;
    }
    if (attempt.server) {
      closeServerPromptly(attempt.server);
      attempt.server = null;
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
    const attemptOrigin = this.resolveCurrentStudioOrigin();
    const codeVerifier = generatePkceVerifier();
    const codeChallenge = derivePkceChallengeS256(codeVerifier);
    const state = generateHandoffState();
    const startedAt = new Date().toISOString();

    let resolveCompletion!: (finalState: DesktopAuthHandoffState) => void;
    const completion = new Promise<DesktopAuthHandoffState>(resolve => {
      resolveCompletion = resolve;
    });

    // Reserve ownership synchronously before any await so overlapping startLogin()
    // calls cleanly supersede earlier ones and cancelLogin() can abort a binding attempt.
    const attempt: ActiveAttempt = {
      id: attemptId,
      startedAt,
      studioOrigin: attemptOrigin,
      codeVerifier,
      expectedState: state,
      redirectUri: '',
      server: null,
      timeoutTimer: null,
      exchangeAbort: null,
      consumed: false,
      settled: false,
      canceled: false,
      resolveCompletion,
    };
    this.activeAttempt = attempt;

    let server: Server;
    let redirectUri: string;
    try {
      const bound = await this.listenLoopback((req, res) => {
        if (attempt.canceled || attempt.settled || this.activeAttempt !== attempt) {
          res.writeHead(409, STATIC_HTML_HEADERS);
          res.end(CALLBACK_ERROR_HTML);
          return;
        }
        this.handleLoopbackRequest(attempt, req, res);
      });
      server = bound.server;
      redirectUri = bound.redirectUri;
    } catch (error) {
      if (this.activeAttempt === attempt) {
        this.activeAttempt = null;
      }
      if (!attempt.settled) {
        this.settleAttempt(attempt, {
          status: 'error',
          startedAt,
          completedAt: new Date().toISOString(),
          errorCode: 'LOOPBACK_BIND_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }

    if (attempt.canceled || attempt.settled || this.activeAttempt !== attempt) {
      closeServerPromptly(server);
      const startUrl = this.buildStartUrl({
        studioOrigin: attemptOrigin,
        codeChallenge,
        redirectUri,
        state,
        switchAccount: options?.switchAccount,
      });
      return {
        startUrl,
        redirectUri,
        state,
        codeChallenge,
        completion,
      };
    }

    attempt.server = server;
    attempt.redirectUri = redirectUri;

    const startUrl = this.buildStartUrl({
      studioOrigin: attemptOrigin,
      codeChallenge,
      redirectUri,
      state,
      switchAccount: options?.switchAccount,
    });

    attempt.timeoutTimer = setTimeout(() => {
      if (attempt.settled || attempt.consumed || attempt.canceled || this.activeAttempt !== attempt) return;
      if (attempt.server) {
        closeServerPromptly(attempt.server);
        attempt.server = null;
      }
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
      if (attempt.canceled || attempt.settled || this.activeAttempt !== attempt) {
        this.cleanupAttempt(attempt);
        return {
          startUrl,
          redirectUri,
          state,
          codeChallenge,
          completion,
        };
      }
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

    if (attempt.consumed || attempt.settled || attempt.canceled || this.activeAttempt !== attempt) {
      res.writeHead(409, STATIC_HTML_HEADERS);
      res.end(CALLBACK_ERROR_HTML);
      return;
    }

    const callbackError = parsedUrl.searchParams.get('error');
    if (callbackError) {
      attempt.consumed = true;
      res.writeHead(400, STATIC_HTML_HEADERS);
      res.end(CALLBACK_ERROR_HTML, () => {
        if (attempt.server) closeServerAfterResponse(attempt.server);
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

    res.writeHead(200, STATIC_HTML_HEADERS);
    res.end(CALLBACK_SUCCESS_HTML, () => {
      if (attempt.server) closeServerAfterResponse(attempt.server);
    });

    void this.performExchange(attempt, code);
  }

  private async performExchange(attempt: ActiveAttempt, code: string): Promise<void> {
    if (attempt.settled || attempt.canceled || this.activeAttempt !== attempt) return;

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
      const response = await this.exchangeFetch(exchangeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
        credentials: 'include',
        signal: abortController.signal,
      });

      if (attempt.canceled || attempt.settled) return;

      if (!response.ok) {
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
        parsedBody = await response.json();
      } catch {
        this.settleAttempt(attempt, {
          status: 'error',
          startedAt: attempt.startedAt,
          completedAt: new Date().toISOString(),
          errorCode: 'INVALID_EXCHANGE_RESPONSE',
          errorMessage: 'Session exchange returned invalid JSON.',
        });
        return;
      }

      if (attempt.canceled || attempt.settled) return;

      if (!isValidExchangeResponse(parsedBody)) {
        this.settleAttempt(attempt, {
          status: 'error',
          startedAt: attempt.startedAt,
          completedAt: new Date().toISOString(),
          errorCode: 'INVALID_EXCHANGE_RESPONSE',
          errorMessage: 'Session exchange response missing user or workspace identity.',
        });
        return;
      }

      this.settleAttempt(attempt, {
        status: 'authenticated',
        startedAt: attempt.startedAt,
        completedAt: new Date().toISOString(),
        user: parsedBody.user,
        workspaceId: parsedBody.workspaceId,
      });

      try {
        this.onFocusMainWindow?.();
      } catch {
        // Ignore window focus errors after successful auth.
      }
    } catch (error) {
      if (attempt.canceled || attempt.settled) return;
      const isAbort = error instanceof Error && error.name === 'AbortError';
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
