import { Hono } from 'hono';
import { isCloudError } from '../contracts/errors.ts';
import { sanitizeEntryId, sanitizeHookId, type CloudTrackingHandle } from '../cloud-tracking.ts';
import { isUuid } from '../../shared/project-validation.ts';
import { mountDesktopHandoffRoutes } from './desktop-handoff.ts';
import { createAuthMiddleware, getAuthContext, type AuthEnv, type AuthMiddlewareDeps } from './middleware.ts';
import {
  buildAuthorizationServerMetadata,
  buildOAuth21Config,
  buildProtectedResourceMetadata,
  exchangeOAuthToken,
  formatRedirectHostLabel,
  issueAuthorizationCode,
  registerOAuthClient,
  renderOAuthConsentHtml,
  revokeOAuthToken,
  validateAuthorizeRequest,
  type OAuth21Config,
} from './oauth21.ts';
import { createPat, listPats, revokePat } from './pat.ts';
import {
  DEFAULT_SESSION_TTL_SEC,
  OIDC_TX_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  clearCookie,
  createBrowserSession,
  isHttpsOrigin,
  parseCookies,
  resolveBrowserSession,
  revokeBrowserSession,
  serializeCookie,
  verifyCsrfOrigin,
} from './session.ts';
import { assertSafeReturnTo, randomBase64Url, sha256Hex, timingSafeStringEqual } from './store.ts';

const OAUTH_CONSENT_TTL_SEC = 600;

function parseBasicClientAuth(header: string | undefined): { clientId: string; clientSecret: string } | null {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep <= 0) return null;
    return {
      clientId: decodeURIComponent(decoded.slice(0, sep)),
      clientSecret: decodeURIComponent(decoded.slice(sep + 1)),
    };
  } catch {
    return null;
  }
}

export interface AuthRoutesDeps extends AuthMiddlewareDeps {
  oauth21?: OAuth21Config;
  cloudTracking?: CloudTrackingHandle;
}

const AUTH_ATTR_COOKIE_NAME = 'om_auth_attr';

function parseAuthAttributionCookie(raw: string | undefined): { hookId?: string; entryId?: string; startedAt?: number } {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as { hookId?: unknown; entryId?: unknown; startedAt?: unknown };
    return {
      hookId: typeof parsed.hookId === 'string' ? sanitizeHookId(parsed.hookId) : undefined,
      entryId: typeof parsed.entryId === 'string' ? sanitizeEntryId(parsed.entryId) : undefined,
      startedAt: typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt) ? parsed.startedAt : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Mounts:
 * - `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me`
 * - `/auth/desktop/start`, `/auth/desktop/exchange`
 * - `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`
 * - `/.well-known/oauth-authorization-server`
 * - `/oauth/register`, `/oauth/authorize` (GET/POST), `/oauth/token`, `/oauth/revoke`
 * - `/motion-api/tokens` (GET/POST), `/motion-api/tokens/:id` (DELETE)
 */
export function createAuthRoutes(deps: AuthRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const oauthCfg = deps.oauth21 ?? buildOAuth21Config(deps.config);
  const secureCookie = isHttpsOrigin(deps.config.APP_PUBLIC_ORIGIN);
  const authMiddleware = createAuthMiddleware({ ...deps, oauth21: oauthCfg });

  // -------------------------------------------------------------------------
  // RFC 9728 & RFC 8414 Well-Known Metadata
  // -------------------------------------------------------------------------

  const serveProtectedResourceMetadata = (c: { json: (data: unknown, status?: 200) => Response; header: (k: string, v: string) => void }) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(buildProtectedResourceMetadata(oauthCfg), 200);
  };

  app.get('/.well-known/oauth-protected-resource', (c) => serveProtectedResourceMetadata(c));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => serveProtectedResourceMetadata(c));

  app.get('/.well-known/oauth-authorization-server', (c) => {
    if (oauthCfg.mode !== 'proxy') {
      return c.json(
        {
          code: 'NOT_FOUND',
          error: 'Authorization server metadata is delegated to the external OIDC issuer',
          issuer: oauthCfg.issuer,
        },
        404,
      );
    }
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(buildAuthorizationServerMetadata(oauthCfg), 200);
  });

  // -------------------------------------------------------------------------
  // Browser OIDC Login / Callback / Logout / Me
  // -------------------------------------------------------------------------

  app.get('/auth/login', async (c) => {
    const returnTo = assertSafeReturnTo(c.req.query('returnTo'));
    const hookId = sanitizeHookId(c.req.query('hook_id'));
    const entryId = sanitizeEntryId(c.req.query('entry_id'));
    const switchAccount = c.req.query('switch') === '1';
    const prompt = c.req.query('prompt') ?? (switchAccount ? 'login' : null);

    if (switchAccount) {
      const cookies = parseCookies(c.req.header('cookie'));
      const rawSession = cookies[SESSION_COOKIE_NAME];
      if (rawSession) {
        await revokeBrowserSession(deps.store, { rawToken: rawSession }, deps.cache);
      }
    }

    if (deps.config.AUTH_MODE === 'dev') {
      return c.redirect(returnTo, 302);
    }
    if (!deps.oidc) {
      return c.json({ code: 'SERVICE_UNAVAILABLE', error: 'OIDC service is not configured' }, 503);
    }
    const { authorizationUrl, txCookieValue } = await deps.oidc.startLogin(returnTo, { prompt });
    const headers = new Headers();
    if (switchAccount) {
      headers.append('Set-Cookie', clearCookie(SESSION_COOKIE_NAME, secureCookie, '/'));
    }
    headers.append(
      'Set-Cookie',
      serializeCookie(OIDC_TX_COOKIE_NAME, txCookieValue, {
        httpOnly: true,
        secure: secureCookie,
        sameSite: 'Lax',
        path: '/auth',
        maxAgeSec: 600,
      }),
    );
    if (hookId || entryId) {
      headers.append(
        'Set-Cookie',
        serializeCookie(
          AUTH_ATTR_COOKIE_NAME,
          encodeURIComponent(JSON.stringify({ hookId, entryId, startedAt: Date.now() })),
          {
            httpOnly: true,
            secure: secureCookie,
            sameSite: 'Lax',
            path: '/auth',
            maxAgeSec: 600,
          },
        ),
      );
    } else {
      headers.append('Set-Cookie', clearCookie(AUTH_ATTR_COOKIE_NAME, secureCookie, '/auth'));
    }
    headers.set('Location', authorizationUrl);
    return new Response(null, { status: 302, headers });
  });

  app.get('/auth/callback', async (c) => {
    if (deps.config.AUTH_MODE === 'dev') {
      return c.redirect('/', 302);
    }
    if (!deps.oidc) {
      return c.json({ code: 'SERVICE_UNAVAILABLE', error: 'OIDC service is not configured' }, 503);
    }
    const code = c.req.query('code') ?? '';
    const state = c.req.query('state') ?? '';
    const iss = c.req.query('iss') ?? null;
    const oauthError = c.req.query('error') ?? null;
    const cookies = parseCookies(c.req.header('cookie'));
    const txCookieValue = cookies[OIDC_TX_COOKIE_NAME] ?? null;
    const authAttribution = parseAuthAttributionCookie(cookies[AUTH_ATTR_COOKIE_NAME]);

    try {
      const { membership, returnTo } = await deps.oidc.completeCallback(deps.store, {
        code,
        state,
        txCookieValue,
        iss,
        error: oauthError,
        amrIdentity: deps.amrIdentity,
      });

      const session = await createBrowserSession(deps.store, {
        userId: membership.user.id,
        workspaceId: membership.workspace.id,
        ttlSec: DEFAULT_SESSION_TTL_SEC,
      });

      if (authAttribution.hookId || authAttribution.entryId) {
        deps.cloudTracking?.trackWebSignInResult({
          outcome: 'success',
          hookId: authAttribution.hookId,
          entryId: authAttribution.entryId,
          userId: membership.user.id,
          durationMs: authAttribution.startedAt ? Date.now() - authAttribution.startedAt : 0,
        });
      }

      const headers = new Headers();
      headers.append('Set-Cookie', clearCookie(OIDC_TX_COOKIE_NAME, secureCookie, '/auth'));
      headers.append('Set-Cookie', clearCookie(AUTH_ATTR_COOKIE_NAME, secureCookie, '/auth'));
      headers.append(
        'Set-Cookie',
        serializeCookie(SESSION_COOKIE_NAME, session.token, {
          httpOnly: true,
          secure: secureCookie,
          sameSite: 'Lax',
          path: '/',
          maxAgeSec: DEFAULT_SESSION_TTL_SEC,
        }),
      );
      headers.set('Location', returnTo);
      return new Response(null, { status: 302, headers });
    } catch (error) {
      if (isCloudError(error)) {
        c.header('Set-Cookie', clearCookie(OIDC_TX_COOKIE_NAME, secureCookie, '/auth'), { append: true });
        c.header('Set-Cookie', clearCookie(AUTH_ATTR_COOKIE_NAME, secureCookie, '/auth'), { append: true });
        return c.json(error.toJSON(), error.status as 400 | 401 | 403 | 500 | 502 | 503);
      }
      throw error;
    }
  });

  app.post('/auth/logout', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const rawSession = cookies[SESSION_COOKIE_NAME];

    if (rawSession) {
      if (!verifyCsrfOrigin(c.req.raw, deps.config.APP_PUBLIC_ORIGIN)) {
        return c.json({ code: 'FORBIDDEN', error: 'CSRF Origin check failed on logout' }, 403);
      }
      await revokeBrowserSession(deps.store, { rawToken: rawSession }, deps.cache);
    }

    c.header('Set-Cookie', clearCookie(SESSION_COOKIE_NAME, secureCookie, '/'));
    let endSessionUrl: string | undefined;
    if (deps.config.AUTH_MODE === 'oidc' && deps.oidc) {
      try {
        const doc = await deps.oidc.discover();
        endSessionUrl = doc.end_session_endpoint;
      } catch {
        // Optional end_session_endpoint discovery failure must not block local logout.
      }
    }
    return c.json({ ok: true, ...(endSessionUrl ? { endSessionUrl } : {}) }, 200);
  });

  app.get('/auth/me', authMiddleware, async (c) => {
    const auth = getAuthContext(c);
    const workspaces = await deps.store.listUserWorkspaces(auth.userId);
    return c.json({
      authenticated: true,
      authMode: auth.authMode,
      authMethod: auth.authMethod,
      user: {
        id: auth.userId,
        email: auth.email ?? null,
        displayName: auth.displayName ?? 'User',
      },
      activeWorkspaceId: auth.workspaceId,
      role: auth.role,
      scopes: [...auth.scopes],
      workspaces,
    });
  });

  mountDesktopHandoffRoutes(app, deps);

  // -------------------------------------------------------------------------
  // OAuth 2.1 Proxy Endpoints (DCR, PKCE Authorize, Token, Revoke)
  // -------------------------------------------------------------------------

  // Per-IP sliding window counter for DCR anti-abuse.
  const localDcrHits = new Map<string, { count: number; resetAt: number }>();

  const checkDcrRateLimit = async (rawIp: string): Promise<boolean> => {
    const ip = rawIp.trim() || 'unknown';
    const limit = oauthCfg.dcrRateLimitPerMin;
    if (deps.cache) {
      const bucket = Math.floor(Date.now() / 60_000);
      const key = `om:oauth:dcr:rl:${sha256Hex(ip)}:${bucket}`;
      const currentRaw = await deps.cache.get(key);
      const current = currentRaw ? Number.parseInt(currentRaw, 10) || 0 : 0;
      if (current >= limit) return false;
      await deps.cache.set(key, String(current + 1), 65);
      return true;
    }
    const now = Date.now();
    const entry = localDcrHits.get(ip);
    if (!entry || now >= entry.resetAt) {
      localDcrHits.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  };

  app.post('/oauth/register', async (c) => {
    if (oauthCfg.mode !== 'proxy') {
      return c.json({ error: 'unsupported_operation', error_description: 'DCR is delegated to external IdP' }, 404);
    }
    const clientIp =
      (deps.config.TRUST_PROXY_HOPS > 0 ? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() : undefined) ||
      c.req.header('x-real-ip')?.trim() ||
      'local';
    if (!(await checkDcrRateLimit(clientIp))) {
      c.header('Retry-After', '60');
      return c.json(
        { error: 'too_many_requests', error_description: 'Dynamic client registration rate limit exceeded' },
        429,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid_client_metadata', error_description: 'Invalid JSON body' }, 400);
    }
    try {
      const registered = await registerOAuthClient(deps.store, body, {
        allowedHttpsHosts: oauthCfg.allowedHttpsHosts,
      });
      return c.json(registered, 201);
    } catch (error) {
      if (isCloudError(error)) {
        return c.json({ error: 'invalid_client_metadata', error_description: error.message }, 400);
      }
      throw error;
    }
  });

  app.get('/oauth/authorize', async (c) => {
    if (oauthCfg.mode !== 'proxy') {
      return c.json({ error: 'unsupported_operation', error_description: 'OAuth is delegated' }, 404);
    }

    let validated;
    try {
      validated = await validateAuthorizeRequest(deps.store, oauthCfg, {
        clientId: c.req.query('client_id'),
        redirectUri: c.req.query('redirect_uri'),
        responseType: c.req.query('response_type'),
        codeChallenge: c.req.query('code_challenge'),
        codeChallengeMethod: c.req.query('code_challenge_method'),
        scope: c.req.query('scope'),
        state: c.req.query('state'),
        resource: c.req.query('resource'),
      });
    } catch (error) {
      if (isCloudError(error)) {
        return c.json({ error: 'invalid_request', error_description: error.message }, 400);
      }
      throw error;
    }

    // Resolve browser user session (or dev tenant in AUTH_MODE=dev).
    const cookies = parseCookies(c.req.header('cookie'));
    const rawSession = cookies[SESSION_COOKIE_NAME];
    let userId: string | null = null;
    let workspaceId: string | null = null;
    let workspaceName = 'Workspace';
    let userEmail: string | null = null;
    let userDisplayName: string | null = null;
    let userAvatarUrl: string | null = null;

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
          userEmail = auth.email ?? null;
          userDisplayName = auth.displayName ?? null;
          userAvatarUrl = auth.avatarUrl ?? null;
          const ws = await deps.store.findWorkspaceById(workspaceId);
          if (ws) workspaceName = ws.name;
        }
      } catch (error) {
        if (isCloudError(error) && error.status === 503) {
          return c.json(error.toJSON(), 503);
        }
        // Inactive / revoked account -> force re-login.
        userId = null;
        workspaceId = null;
      }
    } else if (deps.config.AUTH_MODE === 'dev') {
      const dev = await deps.store.ensureDevTenant({
        workspaceId: deps.config.DEV_WORKSPACE_ID,
        userId: deps.config.DEV_USER_ID,
      });
      userId = dev.user.id;
      workspaceId = dev.workspace.id;
      workspaceName = dev.workspace.name;
      userEmail = dev.user.email;
      userDisplayName = dev.user.displayName;
      userAvatarUrl = dev.user.avatarUrl;
    }

    const currentPath = new URL(c.req.url).pathname + new URL(c.req.url).search;
    if (!userId || !workspaceId) {
      return c.redirect(`/auth/login?returnTo=${encodeURIComponent(currentPath)}`, 302);
    }

    const userWorkspaces = await deps.store.listUserWorkspaces(userId);

    // Bind consent submission to a single-use CSRF token stored in cache.
    const consentToken = randomBase64Url(24);
    if (deps.cache) {
      await deps.cache.set(
        `om:oauth:consent:${sha256Hex(consentToken)}`,
        JSON.stringify({ userId, workspaceId, clientId: validated.client.clientId }),
        OAUTH_CONSENT_TTL_SEC,
      );
    }

    const html = renderOAuthConsentHtml({
      clientName: validated.client.clientName,
      redirectUri: validated.redirectUri,
      workspaceName,
      workspaceId,
      workspaces: userWorkspaces.map((w) => ({ id: w.id, name: w.name, role: w.role })),
      userEmail,
      userDisplayName,
      userAvatarUrl,
      switchAccountUrl: `/auth/login?switch=1&returnTo=${encodeURIComponent(currentPath)}`,
      scopes: validated.scopes,
      formAction: '/oauth/authorize',
      hiddenFields: {
        consent_token: consentToken,
        client_id: validated.client.clientId,
        redirect_uri: validated.redirectUri,
        response_type: 'code',
        code_challenge: validated.codeChallenge,
        code_challenge_method: 'S256',
        scope: validated.scope,
        ...(validated.state ? { state: validated.state } : {}),
        ...(validated.resource ? { resource: validated.resource } : {}),
      },
    });
    return c.html(html, 200);
  });

  app.post('/oauth/authorize', async (c) => {
    if (oauthCfg.mode !== 'proxy') {
      return c.json({ error: 'unsupported_operation' }, 404);
    }

    // Parse form or JSON body.
    const contentType = c.req.header('content-type') ?? '';
    let fields: Record<string, string> = {};
    if (contentType.includes('application/json')) {
      const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') fields[k] = v;
      }
    } else {
      const text = await c.req.text();
      const params = new URLSearchParams(text);
      for (const [k, v] of params.entries()) fields[k] = v;
    }

    // Authenticate the browser session (or dev mode) + enforce CSRF Origin check on cookie sessions.
    const cookies = parseCookies(c.req.header('cookie'));
    const rawSession = cookies[SESSION_COOKIE_NAME];
    let auth;
    if (rawSession) {
      if (!verifyCsrfOrigin(c.req.raw, deps.config.APP_PUBLIC_ORIGIN)) {
        return c.json({ error: 'access_denied', error_description: 'CSRF Origin check failed' }, 403);
      }
      const requestedWs =
        fields.selected_workspace_id && isUuid(fields.selected_workspace_id)
          ? fields.selected_workspace_id
          : null;
      const resolved = await resolveBrowserSession(deps.store, rawSession, {
        authMode: deps.config.AUTH_MODE,
        requestedWorkspaceId: requestedWs,
        cache: deps.cache,
      });
      if (!resolved) {
        return c.json({ error: 'access_denied', error_description: 'Session expired' }, 401);
      }
      try {
        auth =
          deps.config.AUTH_MODE === 'oidc' && deps.amrIdentity
            ? await deps.amrIdentity.verifyAndEnrichAuthContext(deps.store, resolved.auth)
            : resolved.auth;
      } catch (error) {
        if (isCloudError(error)) {
          return c.json(error.toJSON(), error.status as 401 | 403 | 404 | 503);
        }
        throw error;
      }
    } else if (deps.config.AUTH_MODE === 'dev') {
      const dev = await deps.store.ensureDevTenant({
        workspaceId: deps.config.DEV_WORKSPACE_ID,
        userId: deps.config.DEV_USER_ID,
      });
      auth = {
        workspaceId: dev.workspace.id,
        userId: dev.user.id,
        role: dev.role,
        scopes: [...oauthCfg.supportedScopes],
        authMode: 'dev' as const,
        authMethod: 'dev_bypass' as const,
      };
    } else {
      return c.json({ error: 'access_denied', error_description: 'Authentication required' }, 401);
    }

    // Require and verify single-use consent token whenever cache is available.
    if (deps.cache) {
      if (!fields.consent_token) {
        return c.json({ error: 'invalid_request', error_description: 'Missing consent_token' }, 400);
      }
      const key = `om:oauth:consent:${sha256Hex(fields.consent_token)}`;
      const stored = await deps.cache.get(key);
      await deps.cache.del(key);
      if (!stored) {
        return c.json(
          { error: 'invalid_request', error_description: 'Consent token expired or already used' },
          400,
        );
      }
      const parsed = JSON.parse(stored) as { userId: string; clientId: string };
      if (!timingSafeStringEqual(parsed.userId, auth.userId) || parsed.clientId !== fields.client_id) {
        return c.json({ error: 'access_denied', error_description: 'Consent token mismatch' }, 403);
      }
    }

    let validated;
    try {
      validated = await validateAuthorizeRequest(deps.store, oauthCfg, {
        clientId: fields.client_id,
        redirectUri: fields.redirect_uri,
        responseType: fields.response_type ?? 'code',
        codeChallenge: fields.code_challenge,
        codeChallengeMethod: fields.code_challenge_method ?? 'S256',
        scope: fields.scope,
        state: fields.state,
        resource: fields.resource,
      });
    } catch (error) {
      if (isCloudError(error)) {
        return c.json({ error: 'invalid_request', error_description: error.message }, 400);
      }
      throw error;
    }

    if (fields.decision === 'deny') {
      const denyUrl = new URL(validated.redirectUri);
      denyUrl.searchParams.set('error', 'access_denied');
      if (validated.state) denyUrl.searchParams.set('state', validated.state);
      if (oauthCfg.issuer) denyUrl.searchParams.set('iss', oauthCfg.issuer);
      return c.redirect(denyUrl.toString(), 302);
    }

    const { redirectUrl } = await issueAuthorizationCode(deps.store, auth, validated, {
      issuer: oauthCfg.issuer,
    });
    return c.redirect(redirectUrl, 302);
  });

  app.post('/oauth/token', async (c) => {
    if (oauthCfg.mode !== 'proxy') {
      return c.json({ error: 'unsupported_operation' }, 404);
    }

    const contentType = c.req.header('content-type') ?? '';
    let body: Record<string, string> = {};
    if (contentType.includes('application/json')) {
      const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') body[k] = v;
      }
    } else {
      const params = new URLSearchParams(await c.req.text());
      for (const [k, v] of params.entries()) body[k] = v;
    }

    const basic = parseBasicClientAuth(c.req.header('authorization'));
    const clientId = basic?.clientId ?? body.client_id;
    const clientSecret = basic?.clientSecret ?? body.client_secret;

    try {
      const tokenResponse = await exchangeOAuthToken(deps.store, oauthCfg, {
        grantType: body.grant_type ?? '',
        code: body.code,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
        refreshToken: body.refresh_token,
        clientId,
        clientSecret,
        resource: body.resource,
      });
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(tokenResponse, 200);
    } catch (error) {
      if (isCloudError(error)) {
        const oauthError =
          error.status === 401
            ? 'invalid_client'
            : error.message.startsWith('unsupported_grant_type')
              ? 'unsupported_grant_type'
              : 'invalid_grant';
        return c.json({ error: oauthError, error_description: error.message }, error.status as 400 | 401);
      }
      throw error;
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    let token = '';
    if (contentType.includes('application/json')) {
      const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof raw.token === 'string') token = raw.token;
    } else {
      const params = new URLSearchParams(await c.req.text());
      token = params.get('token') ?? '';
    }
    await revokeOAuthToken(deps.store, token);
    return c.json({ ok: true }, 200);
  });

  // -------------------------------------------------------------------------
  // Personal Access Token (PAT) Lifecycle Endpoints
  // -------------------------------------------------------------------------

  app.get('/motion-api/tokens', authMiddleware, async (c) => {
    const auth = getAuthContext(c);
    const tokens = await listPats(deps.store, auth);
    return c.json({ tokens });
  });

  app.post('/motion-api/tokens', authMiddleware, async (c) => {
    const auth = getAuthContext(c);
    // Restrict PAT minting to browser sessions or dev bypass (prevent PAT-minting-PAT privilege loops).
    if (auth.authMethod !== 'session_cookie' && auth.authMethod !== 'dev_bypass') {
      return c.json(
        { code: 'FORBIDDEN', error: 'Personal access tokens can only be created from an interactive browser session.' },
        403,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ code: 'INVALID_ARGUMENT', error: 'Invalid JSON body' }, 400);
    }
    try {
      const created = await createPat(deps.store, auth, {
        name: typeof body.name === 'string' ? body.name : '',
        scopes: Array.isArray(body.scopes) ? (body.scopes as string[]) : undefined,
        expiresInDays:
          typeof body.expiresInDays === 'number' || body.expiresInDays === null
            ? (body.expiresInDays as number | null)
            : undefined,
      });
      return c.json(created, 201);
    } catch (error) {
      if (isCloudError(error)) {
        return c.json(error.toJSON(), error.status as 400 | 401 | 403 | 404 | 409 | 500);
      }
      throw error;
    }
  });

  app.delete('/motion-api/tokens/:id', authMiddleware, async (c) => {
    const auth = getAuthContext(c);
    if (auth.authMethod !== 'session_cookie' && auth.authMethod !== 'dev_bypass') {
      return c.json(
        { code: 'FORBIDDEN', error: 'Personal access tokens can only be revoked from an interactive browser session.' },
        403,
      );
    }
    const tokenId = c.req.param('id');
    if (!isUuid(tokenId)) {
      return c.json({ code: 'INVALID_ARGUMENT', error: 'Invalid token ID' }, 400);
    }
    const revoked = await revokePat(deps.store, auth, tokenId);
    if (!revoked) {
      return c.json({ code: 'NOT_FOUND', error: 'Token not found or already revoked' }, 404);
    }
    return c.json({ ok: true, id: tokenId });
  });

  // -------------------------------------------------------------------------
  // Connected OAuth Applications ("已连接的应用") Management
  // -------------------------------------------------------------------------

  app.get('/motion-api/connections', authMiddleware, async (c) => {
    const auth = getAuthContext(c);
    const apps = await deps.store.listConnectedApps(auth.userId);
    return c.json({
      connections: apps.map((item) => ({
        clientId: item.clientId,
        clientName: item.clientName,
        redirectHost: item.redirectUris[0] ? formatRedirectHostLabel(item.redirectUris[0]) : 'Unknown',
        redirectUris: item.redirectUris,
        workspaceId: item.workspaceId,
        scopes: item.scopes,
        firstAuthorizedAt: item.firstAuthorizedAt.toISOString(),
        lastUsedAt: item.lastUsedAt ? item.lastUsedAt.toISOString() : null,
        activeTokenCount: item.activeTokenCount,
      })),
    });
  });

  app.delete('/motion-api/connections/:clientId', authMiddleware, async (c) => {
    const auth = getAuthContext(c);
    if (auth.authMethod !== 'session_cookie' && auth.authMethod !== 'dev_bypass') {
      return c.json(
        { code: 'FORBIDDEN', error: 'Connected applications can only be revoked from an interactive browser session.' },
        403,
      );
    }
    const clientId = c.req.param('clientId').trim();
    if (!clientId) {
      return c.json({ code: 'INVALID_ARGUMENT', error: 'Invalid clientId' }, 400);
    }
    const revokedTokens = await deps.store.revokeOAuthClientForUser(auth.userId, clientId);
    return c.json({ ok: true, clientId, revokedTokens }, 200);
  });

  return app;
}
