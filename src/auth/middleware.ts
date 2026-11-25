import type { Context, MiddlewareHandler } from 'hono';
import {
  hasMinRole,
  hasScope,
  type AuthContext,
  type AuthEntry,
  type PatScope,
  type WorkspaceRole,
} from '../contracts/auth.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { AppConfig } from '../infra/config.ts';
import type { AmrIdentityClient } from './amr-identity.ts';
import { createDevTenantProvisioner, verifyDevPat } from './dev-auth.ts';
import {
  buildOAuth21Config,
  isOAuthAccessToken,
  verifyOAuthAccessToken,
  type OAuth21Config,
} from './oauth21.ts';
import type { OidcService } from './oidc.ts';
import { isPatToken, verifyPat } from './pat.ts';
import {
  SESSION_COOKIE_NAME,
  isMutatingMethod,
  parseCookies,
  resolveBrowserSession,
  verifyCsrfOrigin,
} from './session.ts';
import type { AuthKeyValueCache, AuthStore } from './store.ts';

export type AuthEnv = {
  Variables: {
    auth: AuthContext;
    previewAssetBase?: string;
    csrfTokenHash?: string;
    sessionTokenHash?: string;
  };
};

export interface AuthMiddlewareDeps {
  config: AppConfig;
  store: AuthStore;
  cache?: AuthKeyValueCache;
  oidc?: OidcService;
  oauth21?: OAuth21Config;
  amrIdentity?: AmrIdentityClient;
  /**
   * When true, even in AUTH_MODE=dev, `/mcp` requires an explicit Bearer token (`DEV_PAT` or DB PAT/OAuth).
   * Defaults to false so local Compose DX works smoothly when no Authorization header AND no Cookie are sent.
   */
  requireBearerOnDevMcp?: boolean;
}

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function buildWwwAuthenticateHeader(resourceMetadataUrl: string, error?: string): string {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl}"`];
  if (error) parts.push(`error="${error}"`);
  return parts.join(', ');
}

async function resolveBearerAuth(
  deps: AuthMiddlewareDeps,
  oauthCfg: OAuth21Config,
  token: string,
  requestedWorkspaceId: string | null,
  provisionDev: () => Promise<AuthContext>,
): Promise<AuthContext | null> {
  // 1. In AUTH_MODE=dev, accept configured DEV_PAT first.
  if (deps.config.AUTH_MODE === 'dev' && verifyDevPat(token, deps.config)) {
    return provisionDev();
  }

  // 2. Personal Access Token (`om_pat_<prefix>_<secret>`).
  if (isPatToken(token)) {
    return verifyPat(deps.store, token, {
      authMode: deps.config.AUTH_MODE,
      cache: deps.cache,
    });
  }

  // 3. OAuth 2.1 proxy access token (`om_oat_...`).
  if (isOAuthAccessToken(token)) {
    return verifyOAuthAccessToken(deps.store, token, {
      authMode: deps.config.AUTH_MODE,
      expectedResource: oauthCfg.resourceUrl,
      cache: deps.cache,
    });
  }

  // 4. Direct OIDC / delegated OAuth 2.1 JWT verified via JWKS (`jose`).
  if (deps.oidc && token.split('.').length === 3) {
    const expectedAudience =
      oauthCfg.mode === 'delegated'
        ? [oauthCfg.resourceUrl, deps.config.OIDC_CLIENT_ID ?? oauthCfg.resourceUrl]
        : deps.config.OIDC_CLIENT_ID;
    return deps.oidc.verifyBearerJwt(deps.store, token, {
      expectedAudience,
      requestedWorkspaceId,
    });
  }

  return null;
}

async function finalizeAuthContext(
  deps: AuthMiddlewareDeps,
  auth: AuthContext,
  entry: AuthEntry,
): Promise<AuthContext> {
  if (deps.config.AUTH_MODE === 'oidc' && deps.amrIdentity) {
    const verified = await deps.amrIdentity.verifyAndEnrichAuthContext(deps.store, auth);
    return { ...verified, entry };
  }
  return { ...auth, entry };
}

/**
 * Standard API auth middleware for `/motion-api/*`, `/api/*`, and `/auth/me`.
 * Supports Bearer tokens (PAT / OAuth 2.1 / OIDC JWT / DEV_PAT), browser `om_session` cookies
 * with CSRF Origin defense on mutating methods, and `AUTH_MODE=dev` auto-provisioned tenant bypass.
 */
export function createAuthMiddleware(deps: AuthMiddlewareDeps): MiddlewareHandler<AuthEnv> {
  const oauthCfg = deps.oauth21 ?? buildOAuth21Config(deps.config);
  const provisionDev = createDevTenantProvisioner(deps.store, deps.config);

  return async (c, next) => {
    const requestedWorkspaceId = c.req.header('x-openmotion-workspace-id') ?? null;

    // Branch A: Explicit Authorization header (always validated strictly; never falls back on invalid token).
    const authHeader = c.req.header('authorization');
    if (authHeader !== undefined) {
      const bearer = extractBearerToken(c.req.raw);
      if (!bearer) {
        return c.json(
          { code: 'UNAUTHORIZED', errorCode: 'auth_required', error: 'Invalid Authorization header format' },
          401,
        );
      }
      try {
        const rawAuth = await resolveBearerAuth(deps, oauthCfg, bearer, requestedWorkspaceId, provisionDev);
        if (!rawAuth) {
          return c.json(
            {
              code: 'UNAUTHORIZED',
              errorCode: 'auth_required',
              sessionExpired: true,
              error: 'Invalid or expired bearer token',
            },
            401,
          );
        }
        const auth = await finalizeAuthContext(deps, rawAuth, 'api');
        c.set('auth', auth);
        await next();
        return;
      } catch (error) {
        if (isCloudError(error)) {
          return c.json(error.toJSON(), error.status as 400 | 401 | 403 | 404 | 409 | 500 | 501 | 503);
        }
        throw error;
      }
    }

    // Branch B: Browser `om_session` cookie (authoritative PG `auth_sessions` + CSRF Origin check).
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionCookie = cookies[SESSION_COOKIE_NAME];
    if (sessionCookie) {
      try {
        const resolved = await resolveBrowserSession(deps.store, sessionCookie, {
          authMode: deps.config.AUTH_MODE,
          requestedWorkspaceId,
          cache: deps.cache,
        });
        if (!resolved) {
          return c.json(
            {
              code: 'UNAUTHORIZED',
              errorCode: 'auth_required',
              sessionExpired: true,
              error: 'Session expired or revoked',
            },
            401,
          );
        }
        if (isMutatingMethod(c.req.method) && !verifyCsrfOrigin(c.req.raw, deps.config.APP_PUBLIC_ORIGIN)) {
          return c.json(
            { code: 'FORBIDDEN', error: 'Cross-origin cookie mutation blocked (CSRF Origin check failed)' },
            403,
          );
        }
        const auth = await finalizeAuthContext(deps, resolved.auth, 'web');
        c.set('auth', auth);
        c.set('csrfTokenHash', resolved.csrfTokenHash);
        c.set('sessionTokenHash', resolved.tokenHash);
        await next();
        return;
      } catch (error) {
        if (isCloudError(error)) {
          return c.json(error.toJSON(), error.status as 400 | 401 | 403 | 404 | 409 | 500 | 501 | 503);
        }
        throw error;
      }
    }

    // Branch C: Local `AUTH_MODE=dev` auto-provisioned single tenant.
    if (deps.config.AUTH_MODE === 'dev') {
      const auth = { ...(await provisionDev()), entry: 'web' as const };
      c.set('auth', auth);
      await next();
      return;
    }

    // Branch D: Unauthenticated in OIDC mode.
    return c.json(
      {
        code: 'UNAUTHORIZED',
        errorCode: 'auth_required',
        sessionExpired: false,
        error: 'Authentication required',
      },
      401,
    );
  };
}

/**
 * Strict Bearer-ONLY auth middleware for Streamable HTTP `/mcp`.
 * NEVER accepts browser `om_session` cookies (prevents cross-site CSRF against MCP tools).
 * Emits RFC 9728 `WWW-Authenticate` challenge on 401.
 */
export function createMcpBearerAuthMiddleware(deps: AuthMiddlewareDeps): MiddlewareHandler<AuthEnv> {
  const oauthCfg = deps.oauth21 ?? buildOAuth21Config(deps.config);
  const provisionDev = createDevTenantProvisioner(deps.store, deps.config);

  return async (c, next) => {
    const authHeader = c.req.header('authorization');
    const cookies = parseCookies(c.req.header('cookie'));
    const hasSessionCookie = Boolean(cookies[SESSION_COOKIE_NAME]);

    // If an Authorization header is present, verify Bearer token strictly.
    if (authHeader !== undefined) {
      const bearer = extractBearerToken(c.req.raw);
      if (!bearer) {
        c.header('WWW-Authenticate', buildWwwAuthenticateHeader(oauthCfg.resourceMetadataUrl, 'invalid_token'));
        return c.json(
          { code: 'UNAUTHORIZED', errorCode: 'auth_required', error: 'Bearer token required for /mcp' },
          401,
        );
      }
      try {
        const rawAuth = await resolveBearerAuth(
          deps,
          oauthCfg,
          bearer,
          c.req.header('x-openmotion-workspace-id') ?? null,
          provisionDev,
        );
        if (!rawAuth) {
          c.header('WWW-Authenticate', buildWwwAuthenticateHeader(oauthCfg.resourceMetadataUrl, 'invalid_token'));
          return c.json(
            { code: 'UNAUTHORIZED', errorCode: 'auth_required', error: 'Invalid or expired bearer token' },
            401,
          );
        }
        const auth = await finalizeAuthContext(deps, rawAuth, 'mcp');
        c.set('auth', auth);
        await next();
        return;
      } catch (error) {
        if (isCloudError(error)) {
          if (error.status === 401) {
            c.header('WWW-Authenticate', buildWwwAuthenticateHeader(oauthCfg.resourceMetadataUrl, 'invalid_token'));
          }
          return c.json(error.toJSON(), error.status as 400 | 401 | 403 | 404 | 409 | 500 | 501 | 503);
        }
        throw error;
      }
    }

    // NEVER accept browser session cookies on /mcp — even in AUTH_MODE=dev!
    if (hasSessionCookie) {
      c.header('WWW-Authenticate', buildWwwAuthenticateHeader(oauthCfg.resourceMetadataUrl, 'invalid_token'));
      return c.json(
        {
          code: 'UNAUTHORIZED',
          errorCode: 'auth_required',
          error: 'Browser session cookies are not accepted on /mcp. Provide an Authorization: Bearer token.',
        },
        401,
      );
    }

    // In AUTH_MODE=dev without cookie and without requireBearerOnDevMcp, allow local DX bypass.
    if (deps.config.AUTH_MODE === 'dev' && !deps.requireBearerOnDevMcp) {
      const auth = { ...(await provisionDev()), entry: 'mcp' as const };
      c.set('auth', auth);
      await next();
      return;
    }

    c.header('WWW-Authenticate', buildWwwAuthenticateHeader(oauthCfg.resourceMetadataUrl));
    return c.json(
      { code: 'UNAUTHORIZED', errorCode: 'auth_required', error: 'Bearer authentication required for /mcp' },
      401,
    );
  };
}

// ---------------------------------------------------------------------------
// RBAC & Strict Scope Enforcement Helpers (Zero PAT Elevation!)
// ---------------------------------------------------------------------------

export function getAuthContext(c: Context<AuthEnv>): AuthContext {
  const auth = c.get('auth');
  if (!auth) {
    throw new CloudError('UNAUTHORIZED', 'Authentication required', { status: 401 });
  }
  return auth;
}

export function assertScope(auth: AuthContext, required: PatScope): void {
  if (!hasScope(auth, required)) {
    throw new CloudError(
      'INSUFFICIENT_SCOPE',
      `Missing required scope '${required}'`,
      { status: 403, applied: false, details: { requiredScope: required } },
    );
  }
}

export function assertMinRole(auth: AuthContext, minimum: WorkspaceRole): void {
  if (!hasMinRole(auth, minimum)) {
    throw new CloudError(
      'FORBIDDEN',
      `Workspace role '${minimum}' or higher is required`,
      { status: 403, applied: false, details: { requiredRole: minimum, actualRole: auth.role } },
    );
  }
}

export function requireScope(required: PatScope): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const auth = getAuthContext(c);
    if (!hasScope(auth, required)) {
      return c.json(
        {
          code: 'INSUFFICIENT_SCOPE',
          error: `Missing required scope '${required}'`,
          details: { requiredScope: required },
        },
        403,
      );
    }
    await next();
  };
}

export function requireRole(minimum: WorkspaceRole): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const auth = getAuthContext(c);
    if (!hasMinRole(auth, minimum)) {
      return c.json(
        {
          code: 'FORBIDDEN',
          error: `Workspace role '${minimum}' or higher is required`,
          details: { requiredRole: minimum, actualRole: auth.role },
        },
        403,
      );
    }
    await next();
  };
}
