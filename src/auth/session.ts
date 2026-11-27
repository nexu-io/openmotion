import { createHmac } from 'node:crypto';
import type { AuthContext, AuthMode } from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import { isUuid } from '../../shared/project-validation.ts';
import {
  randomBase64Url,
  roleAllowedScopes,
  sha256Hex,
  type AuthKeyValueCache,
  type AuthStore,
} from './store.ts';

export const SESSION_COOKIE_NAME = 'om_session';
export const OIDC_TX_COOKIE_NAME = 'om_oidc_tx';
export const ONETAP_CTX_COOKIE_NAME = 'om_onetap_ctx';
export const ONETAP_CTX_COOKIE_PREFIX = 'om_onetap_ctx_';
export const ONETAP_CTX_TTL_SEC = 300;
export const DESKTOP_OIDC_CTX_COOKIE_NAME = 'om_desktop_oidc_ctx';
export const DEFAULT_SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
const SESSION_CACHE_TTL_SEC = 60;

export function oneTapChallengeCookieName(challengeId: string): string {
  return `${ONETAP_CTX_COOKIE_PREFIX}${sha256Hex(challengeId).slice(0, 16)}`;
}

export function oneTapRevokedBindingCacheKey(bindingHash: string): string {
  return `om:onetap:revoked-binding:${bindingHash}`;
}

export function oneTapUserLogoutEpochCacheKey(userId: string): string {
  return `om:onetap:logout-user:${userId}`;
}

export function oneTapSessionBindingCacheKey(tokenHash: string): string {
  return `om:onetap:session-binding:${tokenHash}`;
}

/** AMR Motion session proof stored for a browser session; required to mint a billing handoff ticket. */
export function oneTapSessionProofCacheKey(tokenHash: string): string {
  return `om:amr:session-proof:${tokenHash}`;
}

export function oidcIdTokenCacheKey(rawSessionToken: string): string {
  return `oidc:id_token:${sha256Hex(rawSessionToken)}`;
}

export function isHttpsOrigin(origin: string): boolean {
  try {
    return new URL(origin).protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseCookies(cookieHeader: string | null | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const rawValue = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      result[name] = decodeURIComponent(rawValue);
    } catch {
      result[name] = rawValue;
    }
  }
  return result;
}

export function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    secure: boolean;
    sameSite?: 'Lax' | 'Strict' | 'None';
    path?: string;
    maxAgeSec?: number;
  },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  if (options.maxAgeSec !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSec))}`);
  }
  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearCookie(name: string, secure: boolean, path = '/'): string {
  const parts = [
    `${name}=`,
    `Path=${path}`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function sessionCacheKey(tokenHash: string): string {
  return `om:auth:session:${tokenHash}`;
}

export interface CreatedBrowserSession {
  sessionId: string;
  token: string;
  tokenHash: string;
  csrfToken: string;
  expiresAt: Date;
}

/**
 * Create an authoritative browser session row in PG `auth_sessions`.
 */
export async function createBrowserSession(
  store: AuthStore,
  input: {
    userId: string;
    workspaceId: string;
    ttlSec?: number;
  },
): Promise<CreatedBrowserSession> {
  const token = randomBase64Url(32);
  const csrfToken = randomBase64Url(32);
  const tokenHash = sha256Hex(token);
  const csrfTokenHash = sha256Hex(csrfToken);
  const ttlSec = input.ttlSec ?? DEFAULT_SESSION_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttlSec * 1000);

  const row = await store.createSession({
    userId: input.userId,
    workspaceId: input.workspaceId,
    tokenHash,
    csrfTokenHash,
    expiresAt,
  });

  return {
    sessionId: row.id,
    token,
    tokenHash,
    csrfToken,
    expiresAt: row.expiresAt,
  };
}

interface CachedSessionPayload {
  id: string;
  userId: string;
  workspaceId: string;
  csrfTokenHash: string;
  expiresAtMs: number;
}

export interface ResolvedBrowserSession {
  auth: AuthContext;
  csrfTokenHash: string;
  tokenHash: string;
  expiresAt: Date;
}

/**
 * Resolve a browser `om_session` cookie authoritatively from PG `auth_sessions`
 * (with optional short-lived Redis lookup cache invalidated on revoke/switch).
 */
export async function resolveBrowserSession(
  store: AuthStore,
  rawToken: string,
  options: {
    authMode: AuthMode;
    requestedWorkspaceId?: string | null;
    cache?: AuthKeyValueCache;
  },
): Promise<ResolvedBrowserSession | null> {
  if (!rawToken || rawToken.length < 24 || rawToken.length > 256) return null;
  const tokenHash = sha256Hex(rawToken);
  const cacheKey = sessionCacheKey(tokenHash);

  // Enforce One Tap logout revocation even if /auth/logout completed after
  // POST /auth/one-tap finished its final pre-response barrier check.
  if (options.cache) {
    const rawBinding = await options.cache.get(oneTapSessionBindingCacheKey(tokenHash));
    if (rawBinding) {
      let bindingHash: string | undefined;
      try {
        const parsedBinding = JSON.parse(rawBinding) as { bindingHash?: string };
        bindingHash = parsedBinding.bindingHash;
      } catch {
        // Malformed binding record cannot be trusted; treat as unparseable.
      }
      if (bindingHash) {
        // Read revocation marker OUTSIDE try/catch so Redis read failures fail closed.
        const revokedMarker = await options.cache.get(
          oneTapRevokedBindingCacheKey(bindingHash),
        );
        if (revokedMarker) {
          // Revoke DB session and evict session cache without swallowing errors.
          // Retain oneTapSessionBindingCacheKey until its full 7-day session TTL
          // expires so a cached or retried session can NEVER resurrect after logout.
          await store.revokeSessionByTokenHash(tokenHash);
          await options.cache.del(cacheKey);
          await options.cache.del(oneTapSessionProofCacheKey(tokenHash)).catch(() => {});
          return null;
        }
      }
    }
  }

  let sessionMeta: CachedSessionPayload | null = null;
  if (options.cache) {
    const cached = await options.cache.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as CachedSessionPayload;
        if (parsed.expiresAtMs > Date.now()) {
          sessionMeta = parsed;
        } else {
          await options.cache.del(cacheKey);
        }
      } catch {
        await options.cache.del(cacheKey);
      }
    }
  }

  if (!sessionMeta) {
    const row = await store.findActiveSessionByTokenHash(tokenHash);
    if (!row) return null;
    sessionMeta = {
      id: row.id,
      userId: row.userId,
      workspaceId: row.workspaceId,
      csrfTokenHash: row.csrfTokenHash,
      expiresAtMs: row.expiresAt.getTime(),
    };
    if (options.cache) {
      const remainingSec = Math.floor((sessionMeta.expiresAtMs - Date.now()) / 1000);
      if (remainingSec > 0) {
        await options.cache.set(
          cacheKey,
          JSON.stringify(sessionMeta),
          Math.min(SESSION_CACHE_TTL_SEC, remainingSec),
        );
      }
    }
    void store.touchSession(row.id).catch(() => {});
  }

  let targetWorkspaceId = sessionMeta.workspaceId;
  if (options.requestedWorkspaceId) {
    if (!isUuid(options.requestedWorkspaceId)) {
      throw new CloudError('INVALID_ARGUMENT', 'Invalid X-OpenMotion-Workspace-Id header', {
        status: 400,
      });
    }
    targetWorkspaceId = options.requestedWorkspaceId;
  }

  const membership = await store.findMembership(targetWorkspaceId, sessionMeta.userId);
  if (!membership) {
    if (options.requestedWorkspaceId && options.requestedWorkspaceId !== sessionMeta.workspaceId) {
      throw new CloudError(
        'WORKSPACE_FORBIDDEN',
        'You do not have access to the requested workspace.',
        { status: 403 },
      );
    }
    return null;
  }

  return {
    auth: {
      workspaceId: membership.workspace.id,
      userId: membership.user.id,
      role: membership.role,
      scopes: [...roleAllowedScopes(membership.role)],
      authMode: options.authMode,
      authMethod: 'session_cookie',
      entry: 'web',
      externalWorkspaceId: membership.workspace.externalWorkspaceId,
      authUserId: membership.user.oidcSub,
      appUserId: membership.user.appUserId ?? null,
      sessionId: sessionMeta.id,
      email: membership.user.email,
      displayName: membership.user.displayName,
      avatarUrl: membership.user.avatarUrl,
    },
    csrfTokenHash: sessionMeta.csrfTokenHash,
    tokenHash,
    expiresAt: new Date(sessionMeta.expiresAtMs),
  };
}

export async function revokeBrowserSession(
  store: AuthStore,
  input: { sessionId?: string; rawToken?: string; tokenHash?: string },
  cache?: AuthKeyValueCache,
): Promise<boolean> {
  const tokenHash = input.tokenHash ?? (input.rawToken ? sha256Hex(input.rawToken) : undefined);
  let revoked = false;
  if (tokenHash) {
    revoked = await store.revokeSessionByTokenHash(tokenHash);
    if (cache) {
      await cache.del(sessionCacheKey(tokenHash));
      await cache.del(oneTapSessionBindingCacheKey(tokenHash)).catch(() => {});
    }
  } else if (input.sessionId) {
    revoked = await store.revokeSessionById(input.sessionId);
  }
  return revoked;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/**
 * Detects whether a request carries any browser signal about who initiated it.
 *
 * `Origin`, a non-`none` `Sec-Fetch-Site` and a `Referer` all describe the initiator. A request with
 * none of them came from an address-bar visit, a bookmark or a desktop shell opening the URL, which
 * has no cross-site initiator to worry about. A signal is not proof of a same-origin initiator by
 * itself: callers still compare it with `hasSameOriginFetchMetadata` or `verifyCsrfOrigin`, because
 * a same-origin redirect can produce a same-origin `Referer` from an attacker-initiated navigation.
 */
export function hasCrossSiteInitiatorSignal(request: Request): boolean {
  if (request.headers.get('origin') !== null) return true;
  const secFetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite !== undefined && secFetchSite !== '' && secFetchSite !== 'none') return true;
  const referer = request.headers.get('referer');
  return referer !== null && referer !== '';
}

/**
 * True only when the request's own fetch metadata names this origin.
 *
 * Unlike `verifyCsrfOrigin`, this never falls back to `Referer`, so it cannot be satisfied by a
 * same-origin redirect hop that an attacker started on another site. It also compares the `Origin`
 * header itself, so a caller cannot pass a foreign origin through by presenting one.
 */
export function hasSameOriginFetchMetadata(request: Request, publicOrigin: string): boolean {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(publicOrigin).origin;
  } catch {
    return false;
  }
  const originHeader = request.headers.get('origin');
  if (originHeader !== null) {
    const trimmed = originHeader.trim();
    if (!trimmed || trimmed.toLowerCase() === 'null') return false;
    try {
      return new URL(trimmed).origin === expectedOrigin;
    } catch {
      return false;
    }
  }
  return request.headers.get('sec-fetch-site')?.trim().toLowerCase() === 'same-origin';
}

/**
 * CSRF defense for cookie-authenticated mutations.
 * Requires `Origin` to match `APP_PUBLIC_ORIGIN` exactly (never `'null'` or foreign origin).
 * If `Origin` is omitted by a browser, falls back to `Sec-Fetch-Site: same-origin` or matching `Referer`.
 */
export function verifyCsrfOrigin(request: Request, publicOrigin: string): boolean {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(publicOrigin).origin;
  } catch {
    return false;
  }

  const originHeader = request.headers.get('origin');
  if (originHeader !== null) {
    const trimmed = originHeader.trim();
    if (!trimmed || trimmed.toLowerCase() === 'null') return false;
    try {
      return new URL(trimmed).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  const secFetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite === 'same-origin') {
    return true;
  }

  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  return false;
}

/** Server-only HMAC key that binds upgrade-handoff retry URLs to the originating browser session. */
export function resolveTrackingAttestationSecret(config: {
  SESSION_SECRET?: string;
  APP_PUBLIC_ORIGIN: string;
}): string {
  const base = config.SESSION_SECRET?.trim() || `om-dev-track-att:${config.APP_PUBLIC_ORIGIN}`;
  return createHmac('sha256', base).update('openmotion:tracking-attestation:v1', 'utf8').digest('hex');
}
