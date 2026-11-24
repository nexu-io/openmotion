import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { isCloudError } from '../contracts/errors.ts';
import type { AppConfig } from '../infra/config.ts';
import { isUuid } from '../../shared/project-validation.ts';
import { isAmrOneTapError, type AmrOneTapAttribution } from './amr-identity.ts';
import {
  DESKTOP_OIDC_CTX_TTL_SEC,
  DesktopOidcProvenanceStore,
  mountDesktopHandoffRoutes,
  parseDesktopStartReturnTo,
} from './desktop-handoff.ts';
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
  DESKTOP_OIDC_CTX_COOKIE_NAME,
  OIDC_TX_COOKIE_NAME,
  ONETAP_CTX_COOKIE_NAME,
  ONETAP_CTX_COOKIE_PREFIX,
  ONETAP_CTX_TTL_SEC,
  SESSION_COOKIE_NAME,
  TRACKING_ATTESTATION_COOKIE_NAME,
  clearCookie,
  createBrowserSession,
  isHttpsOrigin,
  oneTapChallengeCookieName,
  parseCookies,
  resolveBrowserSession,
  resolveTrackingAttestationSecret,
  revokeBrowserSession,
  serializeCookie,
  serializeTrackingAttestationCookie,
  verifyCsrfOrigin,
} from './session.ts';
import { assertSafeReturnTo, randomBase64Url, sha256Hex, timingSafeStringEqual } from './store.ts';

const OAUTH_CONSENT_TTL_SEC = 600;
const ONETAP_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const UPGRADE_ALLOWED_TARGET_PREFIXES = [
  '/dashboard',
  '/cloud/dashboard',
  '/pricing',
  '/plans',
  '/zh/pricing',
] as const;
const PUBLIC_PRICING_TARGET_PREFIXES = ['/pricing', '/plans', '/zh/pricing'] as const;
const UPGRADE_ATTRIBUTION_QUERY_KEYS = [
  'billing',
  'od_origin',
  'od_entry_source',
  'od_entry_id',
  'od_entry_at',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

function sanitizeOptionalShortString(raw: unknown, maxLength = 256): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > maxLength || ONETAP_CONTROL_CHAR_RE.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

const METRICS_CONSENT_COOKIE_NAME = 'om_metrics_consent';

function sanitizeOneTapAttribution(
  raw: unknown,
  options: { metricsConsented?: boolean } = {},
): AmrOneTapAttribution | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm', 'landingPath'] as const) {
    const val = sanitizeOptionalShortString(obj[key], 256);
    if (val) out[key] = val;
  }
  if (obj.odEntry && typeof obj.odEntry === 'object' && !Array.isArray(obj.odEntry)) {
    const rawEntry = obj.odEntry as Record<string, unknown>;
    const sanitizedEntry: Record<string, string | boolean> = {};
    const sourceProduct = sanitizeOptionalShortString(rawEntry.sourceProduct, 64);
    const entryId = sanitizeOptionalShortString(rawEntry.entryId, 128);
    const sourceDetail = sanitizeOptionalShortString(rawEntry.sourceDetail, 128);
    const rawEntryOccurredAt = sanitizeOptionalShortString(rawEntry.entryOccurredAt, 64);
    const entryOccurredAt =
      rawEntryOccurredAt && !Number.isNaN(Date.parse(rawEntryOccurredAt))
        ? rawEntryOccurredAt
        : undefined;
    const campaignId = sanitizeOptionalShortString(rawEntry.campaignId, 128);
    const placementId = sanitizeOptionalShortString(rawEntry.placementId, 128);
    const conversionSource = sanitizeOptionalShortString(rawEntry.conversionSource, 128);
    const odDeviceId =
      options.metricsConsented === true && rawEntry.odDeviceIdConsent === true
        ? sanitizeOptionalShortString(rawEntry.odDeviceId, 128)
        : undefined;
    if (sourceProduct) sanitizedEntry.sourceProduct = sourceProduct;
    if (entryId) sanitizedEntry.entryId = entryId;
    if (sourceDetail) sanitizedEntry.sourceDetail = sourceDetail;
    if (entryOccurredAt) sanitizedEntry.entryOccurredAt = entryOccurredAt;
    if (campaignId) sanitizedEntry.campaignId = campaignId;
    if (placementId) sanitizedEntry.placementId = placementId;
    if (conversionSource) sanitizedEntry.conversionSource = conversionSource;
    if (odDeviceId) {
      sanitizedEntry.odDeviceId = odDeviceId;
      sanitizedEntry.odDeviceIdConsent = true;
    }
    if (Object.keys(sanitizedEntry).length > 0) {
      out.odEntry = sanitizedEntry;
    }
  }
  return Object.keys(out).length > 0 ? (out as AmrOneTapAttribution) : undefined;
}

function isPublicPricingTargetPath(targetPath: string): boolean {
  try {
    const parsed = new URL(targetPath, 'https://example.invalid');
    const normalized = parsed.pathname.replace(/\/+$/, '') || '/';
    return PUBLIC_PRICING_TARGET_PREFIXES.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    );
  } catch {
    return false;
  }
}

function resolveGuestPricingRedirectUrl(targetPath: string, config: AppConfig): string | null {
  if (!isPublicPricingTargetPath(targetPath)) return null;
  try {
    const parsedTarget = new URL(targetPath, 'https://example.invalid');
    const baseSource = config.OPENDESIGN_PRICING_URL ?? config.OPENDESIGN_CONSOLE_URL;
    const baseUrl = new URL(baseSource);
    const pathname = parsedTarget.pathname === '/plans' ? '/pricing' : parsedTarget.pathname;
    const dest = new URL(`${pathname}${parsedTarget.search}`, baseUrl.origin);
    return isSafeUpgradeHandoffUrl(dest.toString(), config) ? dest.toString() : null;
  } catch {
    return null;
  }
}

function extractUpgradeAttributionParams(reqUrl: string): URLSearchParams {
  const params = new URLSearchParams();
  try {
    const parsed = new URL(reqUrl);
    for (const key of UPGRADE_ATTRIBUTION_QUERY_KEYS) {
      const value = sanitizeOptionalShortString(parsed.searchParams.get(key), 256);
      if (value) params.set(key, value);
    }
  } catch {
    // Ignore unparseable request URL.
  }
  return params;
}

function resolveSafeUpgradeTargetPath(
  rawTargetPath: string | undefined,
  attributionParams: URLSearchParams,
): string {
  let pathname = '/dashboard';
  const merged = new URLSearchParams();

  if (
    rawTargetPath &&
    rawTargetPath.startsWith('/') &&
    !rawTargetPath.startsWith('//') &&
    !rawTargetPath.includes('\\') &&
    !ONETAP_CONTROL_CHAR_RE.test(rawTargetPath)
  ) {
    try {
      const parsed = new URL(rawTargetPath, 'https://example.invalid');
      const normalized = parsed.pathname.replace(/\/+$/, '') || '/';
      const allowed = UPGRADE_ALLOWED_TARGET_PREFIXES.some(
        (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
      );
      if (allowed) {
        pathname = parsed.pathname;
        for (const [key, value] of parsed.searchParams.entries()) {
          if (
            (UPGRADE_ATTRIBUTION_QUERY_KEYS as readonly string[]).includes(key) &&
            sanitizeOptionalShortString(value, 256)
          ) {
            merged.set(key, value.trim());
          }
        }
      }
    } catch {
      // Fall back to /dashboard.
    }
  }

  for (const [key, value] of attributionParams.entries()) {
    merged.set(key, value);
  }
  const qs = merged.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function renderUpgradeHandoffUnavailableHtml(retryPath: string): string {
  const safeRetryHref = retryPath.replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OpenDesign Account Verification Required</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; background: #191a1b; color: #f7f8f5; }
      main { max-width: 440px; padding: 28px 32px; border-radius: 12px; background: #202123; border: 1px solid #484b4d; text-align: center; }
      h1 { margin: 0 0 10px; font-size: 18px; }
      p { margin: 0 0 18px; font-size: 14px; line-height: 1.5; color: #c0c4bd; }
      a { display: inline-block; padding: 8px 16px; border-radius: 8px; background: #f7f8f5; color: #191a1b; text-decoration: none; font-weight: 600; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Unable to verify billing handoff</h1>
      <p>We could not bind your current OpenDesign account for checkout. To avoid billing the wrong account, please retry in a moment.</p>
      <a href="${safeRetryHref}">Retry</a>
    </main>
  </body>
</html>`;
}

function appendOneTapSuppressHint(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      parsed.searchParams.set('od_onetap_suppress', '1');
      return parsed.toString();
    }
  } catch {
    // Return original URL if unparseable.
  }
  return rawUrl;
}

function isSafeUpgradeHandoffUrl(rawUrl: string, config: AppConfig): boolean {
  if (!rawUrl || ONETAP_CONTROL_CHAR_RE.test(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) return false;
    const allowedOrigins = new Set<string>();
    const configuredUrls = [
      config.OPENDESIGN_API_URL,
      config.OPENDESIGN_CONSOLE_URL,
      config.OPENDESIGN_PRICING_URL,
    ].filter((u): u is string => Boolean(u));
    let allowHttp = false;
    for (const candidate of configuredUrls) {
      try {
        const u = new URL(candidate);
        allowedOrigins.add(u.origin);
        if (u.protocol === 'http:') allowHttp = true;
      } catch {
        // Ignore invalid configured URL.
      }
    }
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
      return false;
    }
    return allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

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
  onOneTapTelemetry?: (event: {
    event: 'onetap_login_success' | 'onetap_login_failed';
    appUserId?: string;
    isNewUser?: boolean;
    planTier?: string;
    errorCode?: string;
  }) => void;
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
  const desktopOidcProvenanceStore = new DesktopOidcProvenanceStore(deps.cache);
  const trackingAttestationSecret = resolveTrackingAttestationSecret(deps.config);

  // Server-side OIDC id_token_hint store (keyed by session tokenHash) for RP-Initiated Logout.
  const localIdTokens = new Map<string, { idToken: string; expiresAt: number }>();
  const idTokenCacheKey = (tokenHash: string) => `om:oidc:id-token:${tokenHash}`;
  const saveSessionIdToken = async (tokenHash: string, idToken: string, ttlSec: number): Promise<void> => {
    if (deps.cache) {
      await deps.cache.set(idTokenCacheKey(tokenHash), idToken, ttlSec);
      return;
    }
    localIdTokens.set(tokenHash, { idToken, expiresAt: Date.now() + ttlSec * 1000 });
  };
  const consumeSessionIdToken = async (tokenHash: string): Promise<string | null> => {
    if (deps.cache) {
      const key = idTokenCacheKey(tokenHash);
      const val = await deps.cache.get(key);
      if (val) await deps.cache.del(key);
      return val ?? null;
    }
    const entry = localIdTokens.get(tokenHash);
    localIdTokens.delete(tokenHash);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.idToken;
  };

  // Server-side AMR Motion sessionProof store (keyed by session tokenHash) required by
  // AMR /api/internal/auth/one-tap/handoff-ticket so Motion proves AMR actually authenticated
  // this user (via One Tap exchange or OIDC id_token claim) before minting a billing handoff ticket.
  const SESSION_PROOF_TTL_SEC = DEFAULT_SESSION_TTL_SEC;
  const localSessionProofs = new Map<string, { proof: string; expiresAt: number }>();
  const sessionProofCacheKey = (tokenHash: string) => `om:amr:session-proof:${tokenHash}`;
  const saveSessionProof = async (tokenHash: string, proof: string, ttlSec = SESSION_PROOF_TTL_SEC): Promise<void> => {
    const trimmed = proof.trim();
    if (!trimmed) return;
    if (deps.cache) {
      await deps.cache.set(sessionProofCacheKey(tokenHash), trimmed, ttlSec);
      return;
    }
    localSessionProofs.set(tokenHash, { proof: trimmed, expiresAt: Date.now() + ttlSec * 1000 });
  };
  const readSessionProof = async (tokenHash: string): Promise<string | null> => {
    if (deps.cache) {
      return (await deps.cache.get(sessionProofCacheKey(tokenHash))) ?? null;
    }
    const entry = localSessionProofs.get(tokenHash);
    if (!entry || entry.expiresAt <= Date.now()) {
      localSessionProofs.delete(tokenHash);
      return null;
    }
    return entry.proof;
  };
  const deleteSessionProof = async (tokenHash: string): Promise<void> => {
    localSessionProofs.delete(tokenHash);
    if (deps.cache) {
      await deps.cache.del(sessionProofCacheKey(tokenHash));
    }
  };

  // Server-side logout revocation barrier: prevents in-flight One Tap exchanges from issuing
  // an om_session after a concurrent /auth/logout completes in another tab.
  let barrierSeq = 0;
  const nextBarrierEpoch = (): number => {
    barrierSeq += 1;
    return Date.now() * 1000 + (barrierSeq % 1000);
  };
  const localRevokedBindings = new Map<string, number>();
  const localUserLogoutEpochs = new Map<string, number>();
  const revokedBindingCacheKey = (bindingHash: string) => `om:onetap:revoked-binding:${bindingHash}`;
  const userLogoutEpochCacheKey = (userId: string) => `om:onetap:logout-user:${userId}`;

  const revokeOneTapBinding = async (bindingHash: string): Promise<void> => {
    const expiresAt = Date.now() + ONETAP_CTX_TTL_SEC * 1000;
    if (deps.cache) {
      await deps.cache.set(revokedBindingCacheKey(bindingHash), String(expiresAt), ONETAP_CTX_TTL_SEC);
    } else {
      localRevokedBindings.set(bindingHash, expiresAt);
    }
  };
  const isOneTapBindingRevoked = async (bindingHash: string): Promise<boolean> => {
    if (deps.cache) {
      const val = await deps.cache.get(revokedBindingCacheKey(bindingHash));
      return Boolean(val);
    }
    const expiresAt = localRevokedBindings.get(bindingHash);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      localRevokedBindings.delete(bindingHash);
      return false;
    }
    return true;
  };
  const recordUserLogoutBarrier = async (userId: string): Promise<void> => {
    const epoch = nextBarrierEpoch();
    localUserLogoutEpochs.set(userId, epoch);
    if (deps.cache) {
      await deps.cache.set(userLogoutEpochCacheKey(userId), String(epoch), ONETAP_CTX_TTL_SEC);
    }
  };
  const hasUserLoggedOutSince = async (userId: string, startedEpoch: number): Promise<boolean> => {
    const localEpoch = localUserLogoutEpochs.get(userId);
    if (localEpoch !== undefined && localEpoch > startedEpoch) {
      return true;
    }
    if (deps.cache) {
      const raw = await deps.cache.get(userLogoutEpochCacheKey(userId));
      const parsed = raw ? Number(raw) : NaN;
      if (Number.isFinite(parsed) && parsed > startedEpoch) {
        return true;
      }
    }
    return false;
  };

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

    try {
      const { membership, returnTo, oneTapVerified, idToken, motionSessionProof } = await deps.oidc.completeCallback(deps.store, {
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
      await saveSessionIdToken(session.tokenHash, idToken, DEFAULT_SESSION_TTL_SEC);
      if (motionSessionProof) {
        await saveSessionProof(session.tokenHash, motionSessionProof, SESSION_PROOF_TTL_SEC);
      }

      const headers = new Headers();
      headers.append('Set-Cookie', clearCookie(OIDC_TX_COOKIE_NAME, secureCookie, '/auth'));
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
      if (membership.user.appUserId) {
        const attCookie = serializeTrackingAttestationCookie(
          cookies[TRACKING_ATTESTATION_COOKIE_NAME],
          membership.user.appUserId,
          trackingAttestationSecret,
          { secure: secureCookie },
        );
        if (attCookie) {
          headers.append('Set-Cookie', attCookie);
        }
      }
      const desktopTarget = parseDesktopStartReturnTo(returnTo);
      if (desktopTarget) {
        const oidcCtxToken = randomBase64Url(24);
        await desktopOidcProvenanceStore.save(sha256Hex(oidcCtxToken), {
          userId: membership.user.id,
          codeChallenge: desktopTarget.codeChallenge,
          redirectUri: desktopTarget.redirectUri,
          oneTapVerified,
          sessionProof: motionSessionProof,
        });
        headers.append(
          'Set-Cookie',
          serializeCookie(DESKTOP_OIDC_CTX_COOKIE_NAME, oidcCtxToken, {
            httpOnly: true,
            secure: secureCookie,
            sameSite: 'Lax',
            path: '/auth/desktop',
            maxAgeSec: DESKTOP_OIDC_CTX_TTL_SEC,
          }),
        );
      }
      headers.set('Location', returnTo);
      return new Response(null, { status: 302, headers });
    } catch (error) {
      if (isCloudError(error)) {
        c.header('Set-Cookie', clearCookie(OIDC_TX_COOKIE_NAME, secureCookie, '/auth'));
        return c.json(error.toJSON(), error.status as 400 | 401 | 403 | 500 | 502 | 503);
      }
      throw error;
    }
  });

  app.post('/auth/logout', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const rawSession = cookies[SESSION_COOKIE_NAME];
    const oneTapCookieEntries = Object.entries(cookies).filter(
      ([name, value]) =>
        Boolean(value) && (name === ONETAP_CTX_COOKIE_NAME || name.startsWith(ONETAP_CTX_COOKIE_PREFIX)),
    );

    if (rawSession || oneTapCookieEntries.length > 0) {
      if (!verifyCsrfOrigin(c.req.raw, deps.config.APP_PUBLIC_ORIGIN)) {
        return c.json({ code: 'FORBIDDEN', error: 'CSRF Origin check failed on logout' }, 403);
      }
    }

    let idTokenHint: string | null = null;
    if (rawSession) {
      const tokenHash = sha256Hex(rawSession);
      const resolved = await resolveBrowserSession(deps.store, rawSession, {
        authMode: deps.config.AUTH_MODE,
        cache: deps.cache,
      }).catch(() => null);
      idTokenHint = await consumeSessionIdToken(tokenHash);
      await deleteSessionProof(tokenHash);
      await revokeBrowserSession(deps.store, { rawToken: rawSession }, deps.cache);
      if (resolved?.auth.userId) {
        await recordUserLogoutBarrier(resolved.auth.userId);
      }
    }

    const headers = new Headers({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    headers.append('Set-Cookie', clearCookie(SESSION_COOKIE_NAME, secureCookie, '/'));
    headers.append('Set-Cookie', clearCookie(ONETAP_CTX_COOKIE_NAME, secureCookie, '/auth/one-tap'));
    headers.append('Set-Cookie', clearCookie(ONETAP_CTX_COOKIE_NAME, secureCookie, '/auth'));
    for (const [cookieName, cookieValue] of oneTapCookieEntries) {
      await revokeOneTapBinding(sha256Hex(cookieValue));
      if (cookieName.startsWith(ONETAP_CTX_COOKIE_PREFIX)) {
        headers.append('Set-Cookie', clearCookie(cookieName, secureCookie, '/auth'));
      }
    }

    // Deliver od_onetap_suppress=1 reliably via OIDC RP-Initiated Logout (id_token_hint +
    // post_logout_redirect_uri) or via a verified configured logout landing URL — never by blindly
    // appending a query parameter onto a bare end_session_endpoint.
    let endSessionUrl: string | undefined;
    const configuredLogoutLanding = deps.config.OIDC_POST_LOGOUT_REDIRECT_URI;
    const postLogoutRedirectUri = appendOneTapSuppressHint(
      configuredLogoutLanding ?? new URL('/', deps.config.APP_PUBLIC_ORIGIN).toString(),
    );
    if (deps.config.AUTH_MODE === 'oidc' && deps.oidc && idTokenHint) {
      try {
        const doc = await deps.oidc.discover();
        if (doc.end_session_endpoint) {
          const logoutUrl = new URL(doc.end_session_endpoint);
          logoutUrl.searchParams.set('id_token_hint', idTokenHint);
          logoutUrl.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
          endSessionUrl = logoutUrl.toString();
        }
      } catch {
        // Optional end_session_endpoint discovery failure must not block local logout.
      }
    }
    if (!endSessionUrl && configuredLogoutLanding) {
      endSessionUrl = postLogoutRedirectUri;
    }

    return new Response(
      JSON.stringify({ ok: true, ...(endSessionUrl ? { endSessionUrl } : {}) }),
      { status: 200, headers },
    );
  });

  app.get('/auth/me', authMiddleware, async (c) => {
    const auth = getAuthContext(c);
    const workspaces = await deps.store.listUserWorkspaces(auth.userId);
    if (auth.authMethod === 'session_cookie' && auth.appUserId) {
      const cookies = parseCookies(c.req.header('cookie'));
      const attCookie = serializeTrackingAttestationCookie(
        cookies[TRACKING_ATTESTATION_COOKIE_NAME],
        auth.appUserId,
        trackingAttestationSecret,
        { secure: secureCookie },
      );
      if (attCookie) {
        c.header('Set-Cookie', attCookie);
      }
    }
    return c.json({
      authenticated: true,
      authMode: auth.authMode,
      authMethod: auth.authMethod,
      user: {
        id: auth.userId,
        appUserId: auth.appUserId ?? null,
        email: auth.email ?? null,
        displayName: auth.displayName ?? 'User',
      },
      activeWorkspaceId: auth.workspaceId,
      role: auth.role,
      scopes: [...auth.scopes],
      workspaces,
    });
  });

  // -------------------------------------------------------------------------
  // Same-Origin Google One Tap & Upgrade Handoff (OIDC + AMR Identity only)
  // -------------------------------------------------------------------------

  if (deps.config.AUTH_MODE === 'oidc' && deps.amrIdentity) {
    const amrIdentity = deps.amrIdentity;
    const expectedOrigin = new URL(deps.config.APP_PUBLIC_ORIGIN).origin;

    app.post('/auth/one-tap/challenge', async (c) => {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');

      if (!verifyCsrfOrigin(c.req.raw, deps.config.APP_PUBLIC_ORIGIN)) {
        return c.json(
          {
            code: 'ORIGIN_NOT_ALLOWED',
            error: 'Origin check failed for One Tap challenge',
            message: 'Origin check failed for One Tap challenge',
          },
          403,
        );
      }

      let rawBody: Record<string, unknown> = {};
      const contentType = c.req.header('content-type') ?? '';
      if (contentType.includes('application/json')) {
        try {
          const parsed = await c.req.json();
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return c.json(
              { code: 'INVALID_ARGUMENT', error: 'Invalid JSON body', message: 'Invalid JSON body' },
              400,
            );
          }
          rawBody = parsed as Record<string, unknown>;
        } catch {
          return c.json(
            { code: 'INVALID_ARGUMENT', error: 'Invalid JSON body', message: 'Invalid JSON body' },
            400,
          );
        }
      }

      let attemptId: string;
      if (rawBody.attemptId === undefined) {
        attemptId = randomUUID();
      } else {
        const sanitized = sanitizeOptionalShortString(rawBody.attemptId, 128);
        if (!sanitized) {
          return c.json(
            {
              code: 'INVALID_ARGUMENT',
              error: 'attemptId must be a non-empty string up to 128 characters',
              message: 'attemptId must be a non-empty string up to 128 characters',
            },
            400,
          );
        }
        attemptId = sanitized;
      }

      // Issue an isolated per-challenge binding cookie (Path=/auth) so concurrent cookieless tabs
      // never overwrite each other's challenge bindings, while /auth/logout can revoke all active bindings.
      const ctxToken = randomBase64Url(32);
      const browserBindingHash = sha256Hex(ctxToken);

      try {
        const challenge = await amrIdentity.requestOneTapChallenge({
          expectedOrigin,
          surface: 'motion_web',
          attemptId,
          browserBindingHash,
        });

        const cookieName = oneTapChallengeCookieName(challenge.challengeId);
        const headers = new Headers({
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          pragma: 'no-cache',
        });
        headers.append(
          'Set-Cookie',
          serializeCookie(cookieName, ctxToken, {
            httpOnly: true,
            secure: secureCookie,
            sameSite: 'Lax',
            path: '/auth',
            maxAgeSec: ONETAP_CTX_TTL_SEC,
          }),
        );
        return new Response(
          JSON.stringify({
            challengeId: challenge.challengeId,
            nonce: challenge.nonce,
            clientId: challenge.clientId,
            expiresAt: challenge.expiresAt,
          }),
          { status: 200, headers },
        );
      } catch (error) {
        if (isAmrOneTapError(error)) {
          return c.json(error.toJSON(), error.status);
        }
        if (isCloudError(error)) {
          return c.json(error.toJSON(), error.status as 400 | 401 | 403 | 409 | 500 | 503);
        }
        throw error;
      }
    });

    app.post('/auth/one-tap', async (c) => {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');

      if (!verifyCsrfOrigin(c.req.raw, deps.config.APP_PUBLIC_ORIGIN)) {
        return c.json(
          {
            code: 'ORIGIN_NOT_ALLOWED',
            error: 'Origin check failed for One Tap login',
            message: 'Origin check failed for One Tap login',
          },
          403,
        );
      }

      let rawBody: Record<string, unknown>;
      try {
        const parsed = await c.req.json();
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return c.json(
            { code: 'INVALID_ARGUMENT', error: 'Invalid JSON body', message: 'Invalid JSON body' },
            400,
          );
        }
        rawBody = parsed as Record<string, unknown>;
      } catch {
        return c.json(
          { code: 'INVALID_ARGUMENT', error: 'Invalid JSON body', message: 'Invalid JSON body' },
          400,
        );
      }

      const challengeId = sanitizeOptionalShortString(rawBody.challengeId, 256);
      const idToken = sanitizeOptionalShortString(rawBody.idToken, 16_384);
      if (!challengeId || !idToken) {
        return c.json(
          {
            code: 'INVALID_ARGUMENT',
            error: 'challengeId and idToken are required',
            message: 'challengeId and idToken are required',
          },
          400,
        );
      }

      const cookies = parseCookies(c.req.header('cookie'));
      const challengeCookieName = oneTapChallengeCookieName(challengeId);
      const perChallengeToken = cookies[challengeCookieName];
      const legacyToken = cookies[ONETAP_CTX_COOKIE_NAME];
      const ctxToken = perChallengeToken || legacyToken;
      const matchedCookieName = perChallengeToken ? challengeCookieName : ONETAP_CTX_COOKIE_NAME;
      const matchedCookiePath = perChallengeToken ? '/auth' : '/auth/one-tap';
      if (!ctxToken || !ctxToken.trim()) {
        c.header('Set-Cookie', clearCookie(challengeCookieName, secureCookie, '/auth'));
        return c.json(
          {
            code: 'CHALLENGE_INVALID',
            error: 'Missing One Tap browser challenge binding cookie',
            message: 'Missing One Tap browser challenge binding cookie',
          },
          400,
        );
      }

      const exchangeStartedEpoch = nextBarrierEpoch();
      const browserBindingHash = sha256Hex(ctxToken);
      if (await isOneTapBindingRevoked(browserBindingHash)) {
        c.header('Set-Cookie', clearCookie(matchedCookieName, secureCookie, matchedCookiePath));
        deps.onOneTapTelemetry?.({
          event: 'onetap_login_failed',
          errorCode: 'CHALLENGE_INVALID',
        });
        return c.json(
          {
            code: 'CHALLENGE_INVALID',
            error: 'One Tap sign-in was canceled after logout.',
            message: 'One Tap sign-in was canceled after logout.',
          },
          409,
        );
      }

      const metricsConsented = cookies[METRICS_CONSENT_COOKIE_NAME] === 'granted';
      const attribution = sanitizeOneTapAttribution(rawBody.attribution, { metricsConsented });
      const referralCode = sanitizeOptionalShortString(rawBody.referralCode, 128);

      try {
        const exchanged = await amrIdentity.exchangeOneTapCredential({
          challengeId,
          idToken,
          expectedOrigin,
          surface: 'motion_web',
          browserBindingHash,
          ...(attribution ? { attribution } : {}),
          ...(referralCode ? { referralCode } : {}),
        });

        const { membership } = await amrIdentity.resolveAndProjectLogin(deps.store, {
          authUserId: exchanged.authUserId,
          email: exchanged.email,
          displayName: exchanged.name || exchanged.email || 'User',
          avatarUrl: exchanged.image,
        });

        // Re-check logout revocation barriers right before creating om_session so a slow in-flight
        // exchange can never resurrect a session after another tab completed /auth/logout.
        const bindingRevokedDuringExchange = await isOneTapBindingRevoked(browserBindingHash);
        const userLoggedOutDuringExchange = await hasUserLoggedOutSince(
          membership.user.id,
          exchangeStartedEpoch,
        );
        if (bindingRevokedDuringExchange || userLoggedOutDuringExchange) {
          c.header('Set-Cookie', clearCookie(matchedCookieName, secureCookie, matchedCookiePath));
          deps.onOneTapTelemetry?.({
            event: 'onetap_login_failed',
            errorCode: 'CHALLENGE_INVALID',
          });
          return c.json(
            {
              code: 'CHALLENGE_INVALID',
              error: 'One Tap sign-in was canceled because you signed out in another tab.',
              message: 'One Tap sign-in was canceled because you signed out in another tab.',
            },
            409,
          );
        }

        const session = await createBrowserSession(deps.store, {
          userId: membership.user.id,
          workspaceId: membership.workspace.id,
          ttlSec: DEFAULT_SESSION_TTL_SEC,
        });

        // Close the TOCTOU window across both DB session commit AND Redis sessionProof save:
        // check after commit, persist sessionProof, then run a final logout barrier check
        // right before returning Set-Cookie.
        const bindingRevokedAfterCommit = await isOneTapBindingRevoked(browserBindingHash);
        const userLoggedOutAfterCommit = await hasUserLoggedOutSince(
          membership.user.id,
          exchangeStartedEpoch,
        );
        if (bindingRevokedAfterCommit || userLoggedOutAfterCommit) {
          await revokeBrowserSession(deps.store, { rawToken: session.token }, deps.cache).catch(() => {});
          c.header('Set-Cookie', clearCookie(matchedCookieName, secureCookie, matchedCookiePath));
          deps.onOneTapTelemetry?.({
            event: 'onetap_login_failed',
            errorCode: 'CHALLENGE_INVALID',
          });
          return c.json(
            {
              code: 'CHALLENGE_INVALID',
              error: 'One Tap sign-in was canceled because you signed out in another tab.',
              message: 'One Tap sign-in was canceled because you signed out in another tab.',
            },
            409,
          );
        }

        if (exchanged.sessionProof) {
          await saveSessionProof(session.tokenHash, exchanged.sessionProof, SESSION_PROOF_TTL_SEC);
          const bindingRevokedAfterProof = await isOneTapBindingRevoked(browserBindingHash);
          const userLoggedOutAfterProof = await hasUserLoggedOutSince(
            membership.user.id,
            exchangeStartedEpoch,
          );
          if (bindingRevokedAfterProof || userLoggedOutAfterProof) {
            await deleteSessionProof(session.tokenHash).catch(() => {});
            await revokeBrowserSession(deps.store, { rawToken: session.token }, deps.cache).catch(() => {});
            c.header('Set-Cookie', clearCookie(matchedCookieName, secureCookie, matchedCookiePath));
            deps.onOneTapTelemetry?.({
              event: 'onetap_login_failed',
              errorCode: 'CHALLENGE_INVALID',
            });
            return c.json(
              {
                code: 'CHALLENGE_INVALID',
                error: 'One Tap sign-in was canceled because you signed out in another tab.',
                message: 'One Tap sign-in was canceled because you signed out in another tab.',
              },
              409,
            );
          }
        }

        const headers = new Headers({
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          pragma: 'no-cache',
        });
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
        headers.append('Set-Cookie', clearCookie(matchedCookieName, secureCookie, matchedCookiePath));
        const attCookie = serializeTrackingAttestationCookie(
          cookies[TRACKING_ATTESTATION_COOKIE_NAME],
          exchanged.appUserId,
          trackingAttestationSecret,
          { secure: secureCookie },
        );
        if (attCookie) {
          headers.append('Set-Cookie', attCookie);
        }

        deps.onOneTapTelemetry?.({
          event: 'onetap_login_success',
          appUserId: exchanged.appUserId,
          isNewUser: exchanged.isNewUser,
          planTier: exchanged.planTier,
        });

        return new Response(
          JSON.stringify({
            authenticated: true,
            user: {
              id: membership.user.id,
              appUserId: exchanged.appUserId,
              email: membership.user.email,
              displayName: membership.user.displayName,
            },
            activeWorkspaceId: membership.workspace.id,
            isNewUser: exchanged.isNewUser,
            planTier: exchanged.planTier,
          }),
          { status: 200, headers },
        );
      } catch (error) {
        if (isAmrOneTapError(error)) {
          deps.onOneTapTelemetry?.({
            event: 'onetap_login_failed',
            errorCode: error.code,
          });
          return c.json(error.toJSON(), error.status);
        }
        if (isCloudError(error)) {
          deps.onOneTapTelemetry?.({
            event: 'onetap_login_failed',
            errorCode: error.code,
          });
          return c.json(error.toJSON(), error.status as 400 | 401 | 403 | 409 | 500 | 503);
        }
        throw error;
      }
    });

    app.get('/auth/upgrade-handoff', async (c) => {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');

      // Non-session Bearer/PAT credentials must never mint browser upgrade handoff tickets.
      if (c.req.header('authorization')) {
        return c.json(
          {
            code: 'FORBIDDEN',
            error: 'Upgrade handoff requires an interactive browser cookie session.',
          },
          403,
        );
      }

      const attributionParams = extractUpgradeAttributionParams(c.req.url);
      const targetPath = resolveSafeUpgradeTargetPath(c.req.query('targetPath'), attributionParams);
      const parsedReqUrl = new URL(c.req.url);
      const retryPath = `${parsedReqUrl.pathname}${parsedReqUrl.search}`;

      const cookies = parseCookies(c.req.header('cookie'));
      const rawSession = cookies[SESSION_COOKIE_NAME];
      const unavailableResponse = () =>
        new Response(renderUpgradeHandoffUnavailableHtml(retryPath), {
          status: 503,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            pragma: 'no-cache',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
            'x-content-type-options': 'nosniff',
          },
        });

      let authUserId: string | null = null;
      let appUserId: string | null = null;
      let hasActiveSession = false;

      if (rawSession) {
        try {
          const resolved = await resolveBrowserSession(deps.store, rawSession, {
            authMode: deps.config.AUTH_MODE,
            cache: deps.cache,
          });
          if (resolved) {
            hasActiveSession = true;
            const enriched = await amrIdentity.verifyAndEnrichAuthContext(deps.store, resolved.auth);
            authUserId = enriched.authUserId ?? null;
            appUserId = enriched.appUserId ?? null;
          }
        } catch (error) {
          // Only explicit 401/403 revoked/inactive account status may treat the session as signed out;
          // ANY DB, Redis, network, or 503 error MUST fail closed with 503 retry page and NO Location.
          if (isCloudError(error) && (error.status === 401 || error.status === 403)) {
            const guestPricingUrl = resolveGuestPricingRedirectUrl(targetPath, deps.config);
            if (guestPricingUrl) {
              return c.redirect(guestPricingUrl, 302);
            }
            return c.json(
              {
                code: 'UNAUTHORIZED',
                error: 'Authentication is required for this upgrade handoff target.',
              },
              401,
            );
          }
          return unavailableResponse();
        }
      }

      if (!hasActiveSession) {
        // Guests requesting public Pricing paths via same-origin /auth/upgrade-handoff (e.g. while
        // header account probe is still in-flight) are safely forwarded to the public Pricing page.
        const guestPricingUrl = resolveGuestPricingRedirectUrl(targetPath, deps.config);
        if (guestPricingUrl) {
          return c.redirect(guestPricingUrl, 302);
        }
        return c.json(
          {
            code: 'UNAUTHORIZED',
            error: 'Authentication is required for this upgrade handoff target.',
          },
          401,
        );
      }

      if (authUserId && appUserId && rawSession) {
        const sessionProof = await readSessionProof(sha256Hex(rawSession));
        if (sessionProof) {
          try {
            const ticket = await amrIdentity.createOneTapHandoffTicket({
              authUserId,
              appUserId,
              sessionProof,
              targetPath,
            });
            if (isSafeUpgradeHandoffUrl(ticket.handoffUrl, deps.config)) {
              return c.redirect(ticket.handoffUrl, 302);
            }
          } catch {
            // Do not redirect to an unbound Pricing page where another AMR browser session could be billed.
          }
        }
      }

      return unavailableResponse();
    });
  }

  mountDesktopHandoffRoutes(app, deps, { oidcProvenanceStore: desktopOidcProvenanceStore });

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
