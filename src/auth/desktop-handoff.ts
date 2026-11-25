import { Hono } from 'hono';
import {
  DESKTOP_HANDOFF_EXCHANGE_PATH,
  DESKTOP_HANDOFF_START_PATH,
  DESKTOP_HANDOFF_TTL_SEC,
  isValidDesktopLoopbackRedirectUri,
  type DesktopHandoffExchangeRequest,
  type DesktopHandoffExchangeResponse,
} from '../../shared/desktop-auth-handoff.ts';
import { isCloudError } from '../contracts/errors.ts';
import type { AuthEnv, AuthMiddlewareDeps } from './middleware.ts';
import {
  DEFAULT_SESSION_TTL_SEC,
  SESSION_COOKIE_NAME,
  createBrowserSession,
  isHttpsOrigin,
  parseCookies,
  resolveBrowserSession,
  serializeCookie,
  verifyCsrfOrigin,
} from './session.ts';
import {
  assertSafeReturnTo,
  randomBase64Url,
  sha256Base64Url,
  sha256Hex,
  timingSafeStringEqual,
  type AuthKeyValueCache,
} from './store.ts';

const DESKTOP_HANDOFF_CACHE_PREFIX = 'om:auth:desktop-handoff:';
const MAX_STATE_LENGTH = 256;
const MAX_REDIRECT_URI_LENGTH = 2048;
const PKCE_BASE64URL_RE = /^[A-Za-z0-9_-]{43,128}$/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const FALLBACK_PRUNE_THRESHOLD = 128;

export interface DesktopHandoffRecord {
  userId: string;
  workspaceId: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

export interface DesktopHandoffOptions {
  /** Override clock for deterministic expiry tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Override handoff code TTL in seconds. Defaults to `DESKTOP_HANDOFF_TTL_SEC` (60s). */
  ttlSec?: number;
}

class DesktopHandoffCodeStore {
  private readonly cache: AuthKeyValueCache | undefined;
  private readonly fallback = new Map<string, DesktopHandoffRecord>();
  private readonly consuming = new Set<string>();
  private readonly now: () => number;
  private readonly ttlSec: number;

  constructor(cache: AuthKeyValueCache | undefined, options: DesktopHandoffOptions = {}) {
    this.cache = cache;
    this.now = options.now ?? (() => Date.now());
    this.ttlSec = options.ttlSec ?? DESKTOP_HANDOFF_TTL_SEC;
  }

  private cacheKey(codeHash: string): string {
    return `${DESKTOP_HANDOFF_CACHE_PREFIX}${codeHash}`;
  }

  private pruneExpiredFallback(currentMs: number): void {
    for (const [hash, entry] of this.fallback.entries()) {
      if (entry.expiresAt <= currentMs) {
        this.fallback.delete(hash);
      }
    }
  }

  async save(codeHash: string, input: Omit<DesktopHandoffRecord, 'expiresAt'>): Promise<DesktopHandoffRecord> {
    const currentMs = this.now();
    const record: DesktopHandoffRecord = {
      ...input,
      expiresAt: currentMs + this.ttlSec * 1000,
    };

    if (this.cache) {
      await this.cache.set(this.cacheKey(codeHash), JSON.stringify(record), this.ttlSec);
    } else {
      if (this.fallback.size >= FALLBACK_PRUNE_THRESHOLD) {
        this.pruneExpiredFallback(currentMs);
      }
      this.fallback.set(codeHash, record);
    }
    return record;
  }

  /**
   * Atomically retrieves and removes a one-time handoff record by its SHA-256 hash.
   * Returns `null` if missing, concurrently being consumed, corrupted, or expired.
   */
  async consume(codeHash: string): Promise<DesktopHandoffRecord | null> {
    if (this.consuming.has(codeHash)) {
      return null;
    }
    this.consuming.add(codeHash);

    try {
      const currentMs = this.now();
      let record: DesktopHandoffRecord | null = null;

      if (this.cache) {
        const key = this.cacheKey(codeHash);
        let raw: string | null;
        if (typeof this.cache.getdel === 'function') {
          raw = await this.cache.getdel(key);
        } else {
          raw = await this.cache.get(key);
          if (raw) {
            await this.cache.del(key);
          }
        }
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw) as Partial<DesktopHandoffRecord>;
          if (
            typeof parsed.userId === 'string' &&
            typeof parsed.workspaceId === 'string' &&
            typeof parsed.codeChallenge === 'string' &&
            typeof parsed.redirectUri === 'string' &&
            typeof parsed.expiresAt === 'number'
          ) {
            record = {
              userId: parsed.userId,
              workspaceId: parsed.workspaceId,
              codeChallenge: parsed.codeChallenge,
              redirectUri: parsed.redirectUri,
              expiresAt: parsed.expiresAt,
            };
          }
        } catch {
          return null;
        }
      } else {
        const existing = this.fallback.get(codeHash);
        if (!existing) return null;
        this.fallback.delete(codeHash);
        record = existing;
      }

      if (!record || record.expiresAt <= currentMs) {
        return null;
      }
      return record;
    } finally {
      this.consuming.delete(codeHash);
    }
  }
}

function validateStartParams(params: {
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
  redirectUri: string | undefined;
  state: string | undefined;
}):
  | {
      ok: true;
      codeChallenge: string;
      redirectUri: string;
      state: string;
    }
  | { ok: false; error: string } {
  const { codeChallenge, codeChallengeMethod, redirectUri, state } = params;

  if (!codeChallenge || !PKCE_BASE64URL_RE.test(codeChallenge)) {
    return {
      ok: false,
      error: 'code_challenge must be a valid base64url-encoded PKCE S256 challenge (43-128 characters)',
    };
  }
  if (codeChallengeMethod !== 'S256') {
    return {
      ok: false,
      error: 'code_challenge_method must be S256',
    };
  }
  if (
    !redirectUri ||
    redirectUri.length > MAX_REDIRECT_URI_LENGTH ||
    !isValidDesktopLoopbackRedirectUri(redirectUri)
  ) {
    return {
      ok: false,
      error: 'redirect_uri must be a valid loopback HTTP URI with a non-privileged port',
    };
  }
  if (
    !state ||
    state.trim().length === 0 ||
    state.length > MAX_STATE_LENGTH ||
    CONTROL_CHAR_RE.test(state)
  ) {
    return {
      ok: false,
      error: `state is required and must be a non-empty string up to ${MAX_STATE_LENGTH} characters`,
    };
  }

  return { ok: true, codeChallenge, redirectUri, state };
}

function parseExchangeBody(raw: unknown):
  | { ok: true; body: DesktopHandoffExchangeRequest }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const code = obj.code;
  const codeVerifier = obj.codeVerifier;
  const redirectUri = obj.redirectUri;

  if (typeof code !== 'string' || code.trim().length === 0 || code.length > 256 || CONTROL_CHAR_RE.test(code)) {
    return { ok: false, error: 'code is required and must be a non-empty string' };
  }
  if (
    typeof codeVerifier !== 'string' ||
    codeVerifier.trim().length === 0 ||
    codeVerifier.length > 256 ||
    CONTROL_CHAR_RE.test(codeVerifier)
  ) {
    return { ok: false, error: 'codeVerifier is required and must be a non-empty string' };
  }
  if (
    typeof redirectUri !== 'string' ||
    redirectUri.length > MAX_REDIRECT_URI_LENGTH ||
    !isValidDesktopLoopbackRedirectUri(redirectUri)
  ) {
    return {
      ok: false,
      error: 'redirectUri must be a valid loopback HTTP URI with a non-privileged port',
    };
  }

  return {
    ok: true,
    body: { code, codeVerifier, redirectUri },
  };
}

/**
 * Mounts the Desktop System-Browser Session Handoff endpoints:
 * - `GET /auth/desktop/start`
 * - `POST /auth/desktop/exchange`
 */
export function mountDesktopHandoffRoutes(
  app: Hono<AuthEnv>,
  deps: AuthMiddlewareDeps,
  options: DesktopHandoffOptions = {},
): void {
  const codeStore = new DesktopHandoffCodeStore(deps.cache, options);
  const secureCookie = isHttpsOrigin(deps.config.APP_PUBLIC_ORIGIN);

  app.get(DESKTOP_HANDOFF_START_PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');

    const validated = validateStartParams({
      codeChallenge: c.req.query('code_challenge'),
      codeChallengeMethod: c.req.query('code_challenge_method'),
      redirectUri: c.req.query('redirect_uri'),
      state: c.req.query('state'),
    });
    if ('error' in validated) {
      return c.json({ code: 'INVALID_REQUEST', error: validated.error }, 400);
    }

    const switchAccount = c.req.query('switch') === '1';

    // Build a clean returnTo URL with validated params only (and without switch=1 to prevent redirect loops).
    const returnParams = new URLSearchParams({
      code_challenge: validated.codeChallenge,
      code_challenge_method: 'S256',
      redirect_uri: validated.redirectUri,
      state: validated.state,
    });
    const safeReturnTo = assertSafeReturnTo(`${DESKTOP_HANDOFF_START_PATH}?${returnParams.toString()}`);

    if (switchAccount) {
      return c.redirect(`/auth/login?switch=1&returnTo=${encodeURIComponent(safeReturnTo)}`, 302);
    }

    const cookies = parseCookies(c.req.header('cookie'));
    const rawSession = cookies[SESSION_COOKIE_NAME];
    let userId: string | null = null;
    let workspaceId: string | null = null;

    if (rawSession) {
      try {
        const resolved = await resolveBrowserSession(deps.store, rawSession, {
          authMode: deps.config.AUTH_MODE,
          cache: deps.cache,
        });
        if (resolved) {
          const auth =
            deps.config.AUTH_MODE === 'oidc' && deps.amrIdentity
              ? await deps.amrIdentity.verifyAndEnrichAuthContext(deps.store, resolved.auth)
              : resolved.auth;
          userId = auth.userId;
          workspaceId = auth.workspaceId;
        }
      } catch (error) {
        if (isCloudError(error) && error.status === 503) {
          return c.json(error.toJSON(), 503);
        }
        // Inactive or revoked account -> require fresh browser login.
        userId = null;
        workspaceId = null;
      }
    }

    if ((!userId || !workspaceId) && deps.config.AUTH_MODE === 'dev') {
      const dev = await deps.store.ensureDevTenant({
        workspaceId: deps.config.DEV_WORKSPACE_ID,
        userId: deps.config.DEV_USER_ID,
      });
      userId = dev.user.id;
      workspaceId = dev.workspace.id;
    }

    if (!userId || !workspaceId) {
      return c.redirect(`/auth/login?returnTo=${encodeURIComponent(safeReturnTo)}`, 302);
    }

    const code = randomBase64Url(32);
    const codeHash = sha256Hex(code);
    await codeStore.save(codeHash, {
      userId,
      workspaceId,
      codeChallenge: validated.codeChallenge,
      redirectUri: validated.redirectUri,
    });

    const redirectTarget = new URL(validated.redirectUri);
    redirectTarget.searchParams.set('code', code);
    redirectTarget.searchParams.set('state', validated.state);

    return c.redirect(redirectTarget.toString(), 302);
  });

  app.post(DESKTOP_HANDOFF_EXCHANGE_PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');

    // Reject cross-site browser requests (login CSRF / session fixation) while
    // still permitting native Electron `session.fetch` calls that send no Origin
    // or Sec-Fetch-Site header.
    const originHeader = c.req.raw.headers.get('origin');
    const secFetchSite = c.req.raw.headers.get('sec-fetch-site')?.trim().toLowerCase();
    const hasCrossSiteSignal =
      originHeader !== null ||
      (secFetchSite !== undefined && secFetchSite !== '' && secFetchSite !== 'none');
    if (hasCrossSiteSignal && !verifyCsrfOrigin(c.req.raw, deps.config.APP_PUBLIC_ORIGIN)) {
      return c.json(
        { code: 'CSRF_FORBIDDEN', error: 'Cross-site requests are not allowed on desktop handoff exchange' },
        403,
      );
    }

    let rawJson: unknown;
    try {
      rawJson = await c.req.json();
    } catch {
      return c.json({ code: 'INVALID_REQUEST', error: 'Invalid JSON request body' }, 400);
    }

    const parsed = parseExchangeBody(rawJson);
    if ('error' in parsed) {
      return c.json({ code: 'INVALID_REQUEST', error: parsed.error }, 400);
    }

    const { code, codeVerifier, redirectUri } = parsed.body;
    const record = await codeStore.consume(sha256Hex(code));
    if (!record) {
      return c.json(
        { code: 'UNAUTHORIZED', error: 'Handoff code is invalid, expired, or already used' },
        401,
      );
    }

    if (!timingSafeStringEqual(redirectUri, record.redirectUri)) {
      return c.json(
        { code: 'INVALID_REQUEST', error: 'redirectUri does not match the handoff code' },
        400,
      );
    }

    if (
      codeVerifier.length < 43 ||
      codeVerifier.length > 128 ||
      !timingSafeStringEqual(sha256Base64Url(codeVerifier), record.codeChallenge)
    ) {
      return c.json(
        { code: 'UNAUTHORIZED', error: 'PKCE codeVerifier verification failed' },
        401,
      );
    }

    const membership = await deps.store.findMembership(record.workspaceId, record.userId);
    if (!membership) {
      return c.json(
        { code: 'UNAUTHORIZED', error: 'User or workspace membership is no longer active' },
        401,
      );
    }

    const session = await createBrowserSession(deps.store, {
      userId: membership.user.id,
      workspaceId: membership.workspace.id,
      ttlSec: DEFAULT_SESSION_TTL_SEC,
    });

    const cookieHeader = serializeCookie(SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'Lax',
      path: '/',
      maxAgeSec: DEFAULT_SESSION_TTL_SEC,
    });
    c.header('Set-Cookie', cookieHeader);

    const responseBody: DesktopHandoffExchangeResponse = {
      ok: true,
      user: {
        id: membership.user.id,
        email: membership.user.email,
        name: membership.user.displayName,
      },
      workspaceId: membership.workspace.id,
    };
    return c.json(responseBody, 200);
  });
}

export function createDesktopHandoffRoutes(
  deps: AuthMiddlewareDeps,
  options: DesktopHandoffOptions = {},
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  mountDesktopHandoffRoutes(app, deps, options);
  return app;
}
