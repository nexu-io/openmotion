import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { isUuid } from '../../shared/project-validation.ts';
import type { AuthContext, PatScope } from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { AppConfig } from '../infra/config.ts';
import type { AmrIdentityClient } from './amr-identity.ts';
import {
  assertSafeReturnTo,
  intersectScopesWithRole,
  isValidPatScope,
  randomBase64Url,
  roleAllowedScopes,
  sha256Base64Url,
  sha256Hex,
  timingSafeStringEqual,
  type AuthKeyValueCache,
  type AuthStore,
  type MembershipResolution,
} from './store.ts';

export const ASYMMETRIC_OIDC_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

export const SYMMETRIC_OIDC_ALGS = ['HS256'] as const;

export const OIDC_CANCELLED_ERRORS: ReadonlySet<string> = new Set([
  'access_denied',
  'login_required',
  'consent_required',
  'interaction_required',
  'account_selection_required',
  'cancelled',
  'canceled',
]);

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
}

export interface OidcClientConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  callbackUrl: string;
  scopes: string;
  audience?: string;
  claimSub: string;
  claimEmail: string;
  claimName: string;
  claimWorkspace?: string;
  discovery?: OidcDiscoveryDocument;
  jwks?: JWTVerifyGetKey;
  fetcher?: typeof fetch;
}

export function oidcConfigFromAppConfig(config: AppConfig): OidcClientConfig {
  if (!config.OIDC_ISSUER || !config.OIDC_CLIENT_ID) {
    throw new CloudError('SERVICE_UNAVAILABLE', 'OIDC_ISSUER and OIDC_CLIENT_ID are required', {
      status: 500,
    });
  }
  const baseOrigin = config.APP_PUBLIC_ORIGIN.replace(/\/$/, '');
  return {
    issuer: config.OIDC_ISSUER.replace(/\/$/, ''),
    clientId: config.OIDC_CLIENT_ID,
    clientSecret: config.OIDC_CLIENT_SECRET,
    callbackUrl: config.OIDC_CALLBACK_URL ?? `${baseOrigin}/auth/callback`,
    scopes: config.OIDC_SCOPES,
    claimSub: config.OIDC_CLAIM_SUB,
    claimEmail: config.OIDC_CLAIM_EMAIL,
    claimName: config.OIDC_CLAIM_NAME,
    claimWorkspace: config.OIDC_CLAIM_WORKSPACE,
  };
}

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = sha256Base64Url(codeVerifier);
  return { codeVerifier, codeChallenge };
}

export function verifyPkceS256(codeVerifier: string, expectedChallenge: string): boolean {
  if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  const computed = sha256Base64Url(codeVerifier);
  return timingSafeStringEqual(computed, expectedChallenge);
}

interface OidcTransactionRecord {
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  txSecretHash: string;
  createdAt: number;
}

const OIDC_TX_TTL_SEC = 600; // 10 minutes

export function oidcTxCacheKey(state: string): string {
  return `om:oidc:tx:${state}`;
}

function readStringClaim(payload: JWTPayload, claimName: string): string | null {
  const value = payload[claimName];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return null;
}

export class OidcService {
  private readonly cfg: OidcClientConfig;
  private readonly cache: AuthKeyValueCache;
  private readonly fetcher: typeof fetch;
  private cachedDiscovery: { doc: OidcDiscoveryDocument; expiresAt: number } | null = null;
  private cachedJwks: JWTVerifyGetKey | null = null;

  constructor(cfg: OidcClientConfig, cache: AuthKeyValueCache) {
    this.cfg = cfg;
    this.cache = cache;
    this.fetcher = cfg.fetcher ?? fetch;
    if (cfg.discovery) {
      this.cachedDiscovery = { doc: cfg.discovery, expiresAt: Number.MAX_SAFE_INTEGER };
    }
    if (cfg.jwks) {
      this.cachedJwks = cfg.jwks;
    }
  }

  async discover(): Promise<OidcDiscoveryDocument> {
    if (this.cachedDiscovery && Date.now() < this.cachedDiscovery.expiresAt) {
      return this.cachedDiscovery.doc;
    }
    const url = `${this.cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const response = await this.fetcher(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new CloudError(
        'SERVICE_UNAVAILABLE',
        `OIDC discovery failed with HTTP ${response.status}`,
        { status: 502 },
      );
    }
    const doc = (await response.json()) as Partial<OidcDiscoveryDocument>;
    const jwksUri =
      typeof doc.jwks_uri === 'string' && doc.jwks_uri.trim().length > 0
        ? doc.jwks_uri.trim()
        : undefined;
    const supportedAlgs = Array.isArray(doc.id_token_signing_alg_values_supported)
      ? doc.id_token_signing_alg_values_supported.filter((v): v is string => typeof v === 'string')
      : undefined;
    const supportsHs256 =
      Boolean(this.cfg.clientSecret) && (!supportedAlgs || supportedAlgs.includes('HS256'));
    if (
      !doc.issuer ||
      !doc.authorization_endpoint ||
      !doc.token_endpoint ||
      (!jwksUri && !this.cachedJwks && !supportsHs256)
    ) {
      throw new CloudError('SERVICE_UNAVAILABLE', 'OIDC discovery document is incomplete', {
        status: 502,
      });
    }
    const resolved: OidcDiscoveryDocument = {
      issuer: doc.issuer,
      authorization_endpoint: doc.authorization_endpoint,
      token_endpoint: doc.token_endpoint,
      jwks_uri: jwksUri,
      userinfo_endpoint: doc.userinfo_endpoint,
      end_session_endpoint: doc.end_session_endpoint,
      id_token_signing_alg_values_supported: supportedAlgs,
    };
    this.cachedDiscovery = { doc: resolved, expiresAt: Date.now() + 15 * 60 * 1000 };
    return resolved;
  }

  async getJwks(): Promise<JWTVerifyGetKey | null> {
    if (this.cachedJwks) return this.cachedJwks;
    const doc = await this.discover();
    if (!doc.jwks_uri) return null;
    this.cachedJwks = createRemoteJWKSet(new URL(doc.jwks_uri), {
      cooldownDuration: 30_000,
      cacheMaxAge: 5 * 60 * 1000,
    });
    return this.cachedJwks;
  }

  private async verifyIdToken(idToken: string, doc: OidcDiscoveryDocument): Promise<JWTPayload> {
    const header = decodeProtectedHeader(idToken);
    const alg = header.alg;

    if (alg === 'HS256') {
      const supported = doc.id_token_signing_alg_values_supported;
      const hs256Allowed =
        supported && supported.length > 0
          ? supported.includes('HS256')
          : !doc.jwks_uri && !this.cachedJwks;
      if (!this.cfg.clientSecret || !hs256Allowed) {
        throw new Error('HS256 id_token is not permitted for this OIDC configuration');
      }
      const verified = await jwtVerify(idToken, new TextEncoder().encode(this.cfg.clientSecret), {
        issuer: doc.issuer,
        audience: this.cfg.clientId,
        algorithms: [...SYMMETRIC_OIDC_ALGS],
      });
      return verified.payload;
    }

    if (typeof alg === 'string' && (ASYMMETRIC_OIDC_ALGS as readonly string[]).includes(alg)) {
      const jwks = await this.getJwks();
      if (!jwks) {
        throw new Error('No JWKS available to verify asymmetric id_token');
      }
      const verified = await jwtVerify(idToken, jwks, {
        issuer: doc.issuer,
        audience: this.cfg.clientId,
        algorithms: [...ASYMMETRIC_OIDC_ALGS],
      });
      return verified.payload;
    }

    throw new Error('Unsupported id_token signing algorithm');
  }

  async startLogin(
    returnTo?: string | null,
    options: { prompt?: string | null } = {},
  ): Promise<{
    authorizationUrl: string;
    state: string;
    txCookieValue: string;
  }> {
    const doc = await this.discover();
    const state = randomBase64Url(24);
    const nonce = randomBase64Url(24);
    const txCookieValue = randomBase64Url(24);
    const { codeVerifier, codeChallenge } = generatePkcePair();

    const txRecord: OidcTransactionRecord = {
      nonce,
      codeVerifier,
      returnTo: assertSafeReturnTo(returnTo),
      txSecretHash: sha256Hex(txCookieValue),
      createdAt: Date.now(),
    };
    await this.cache.set(oidcTxCacheKey(state), JSON.stringify(txRecord), OIDC_TX_TTL_SEC);

    const authUrl = new URL(doc.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', this.cfg.clientId);
    authUrl.searchParams.set('redirect_uri', this.cfg.callbackUrl);
    authUrl.searchParams.set('scope', this.cfg.scopes);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', nonce);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (options.prompt && ['login', 'select_account', 'consent'].includes(options.prompt)) {
      authUrl.searchParams.set('prompt', options.prompt);
    }

    return {
      authorizationUrl: authUrl.toString(),
      state,
      txCookieValue,
    };
  }

  /**
   * Resolves an OIDC authorization error callback (such as `login_required` or `access_denied`
   * when the user clicks "Cancel" on the IdP login screen).
   *
   * Security guarantees:
   * - Always consumes the single-use `state` transaction in cache so it cannot be replayed.
   * - Verifies the `om_oidc_tx` cookie binding (and optional RFC 9207 `iss`) before honoring `returnTo`.
   * - Returns `{ returnTo }` only for known user-cancellation errors with a verified transaction;
   *   otherwise throws 401 `CloudError('UNAUTHORIZED', ...)`.
   */
  async resolveCancelledCallback(input: {
    state: string;
    txCookieValue?: string | null;
    iss?: string | null;
    error: string;
  }): Promise<{ returnTo: string }> {
    const key = input.state ? oidcTxCacheKey(input.state) : null;
    const rawTx = key ? await this.cache.get(key) : null;
    if (key) {
      await this.cache.del(key); // Single-use transaction — never allow replay after error callback
    }

    if (
      !OIDC_CANCELLED_ERRORS.has(input.error) ||
      !rawTx ||
      !input.txCookieValue
    ) {
      throw new CloudError('UNAUTHORIZED', `OIDC authorization failed: ${input.error}`, {
        status: 401,
      });
    }

    let tx: OidcTransactionRecord;
    try {
      tx = JSON.parse(rawTx) as OidcTransactionRecord;
    } catch {
      throw new CloudError('UNAUTHORIZED', 'Corrupted OIDC state transaction', { status: 401 });
    }

    if (!timingSafeStringEqual(sha256Hex(input.txCookieValue), tx.txSecretHash)) {
      throw new CloudError('UNAUTHORIZED', 'OIDC login state binding mismatch', { status: 401 });
    }

    if (input.iss) {
      const expectedIssuer = this.cachedDiscovery?.doc.issuer ?? this.cfg.issuer;
      if (input.iss !== expectedIssuer) {
        throw new CloudError('UNAUTHORIZED', 'OIDC callback issuer mismatch', { status: 401 });
      }
    }

    return { returnTo: assertSafeReturnTo(tx.returnTo) };
  }

  async completeCallback(
    store: AuthStore,
    input: {
      code: string;
      state: string;
      txCookieValue?: string | null;
      iss?: string | null;
      error?: string | null;
      amrIdentity?: AmrIdentityClient;
    },
  ): Promise<{ membership: MembershipResolution; returnTo: string }> {
    if (input.error) {
      if (input.state) {
        await this.cache.del(oidcTxCacheKey(input.state));
      }
      throw new CloudError('UNAUTHORIZED', `OIDC authorization failed: ${input.error}`, {
        status: 401,
      });
    }

    if (!input.code || !input.state || !input.txCookieValue) {
      throw new CloudError('UNAUTHORIZED', 'Missing OIDC callback parameters or state cookie', {
        status: 401,
      });
    }

    const key = oidcTxCacheKey(input.state);
    const rawTx = await this.cache.get(key);
    await this.cache.del(key); // Single-use transaction
    if (!rawTx) {
      throw new CloudError('UNAUTHORIZED', 'OIDC login session expired or invalid state', {
        status: 401,
      });
    }

    let tx: OidcTransactionRecord;
    try {
      tx = JSON.parse(rawTx) as OidcTransactionRecord;
    } catch {
      throw new CloudError('UNAUTHORIZED', 'Corrupted OIDC state transaction', { status: 401 });
    }

    if (!timingSafeStringEqual(sha256Hex(input.txCookieValue), tx.txSecretHash)) {
      throw new CloudError('UNAUTHORIZED', 'OIDC login state binding mismatch', { status: 401 });
    }

    const doc = await this.discover();
    if (input.iss && input.iss !== doc.issuer) {
      throw new CloudError('UNAUTHORIZED', 'OIDC callback issuer mismatch', { status: 401 });
    }
    const form = new URLSearchParams();
    form.set('grant_type', 'authorization_code');
    form.set('code', input.code);
    form.set('redirect_uri', this.cfg.callbackUrl);
    form.set('client_id', this.cfg.clientId);
    form.set('code_verifier', tx.codeVerifier);
    if (this.cfg.clientSecret) {
      form.set('client_secret', this.cfg.clientSecret);
    }

    const tokenRes = await this.fetcher(doc.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!tokenRes.ok) {
      throw new CloudError(
        'UNAUTHORIZED',
        `OIDC token exchange failed with HTTP ${tokenRes.status}`,
        { status: 401 },
      );
    }

    const tokenJson = (await tokenRes.json()) as { id_token?: string; access_token?: string };
    if (!tokenJson.id_token || typeof tokenJson.id_token !== 'string') {
      throw new CloudError('UNAUTHORIZED', 'OIDC token response did not include an id_token', {
        status: 401,
      });
    }

    let payload: JWTPayload;
    try {
      payload = await this.verifyIdToken(tokenJson.id_token, doc);
    } catch {
      throw new CloudError('UNAUTHORIZED', 'OIDC id_token verification failed', { status: 401 });
    }

    if (typeof payload.nonce !== 'string' || !timingSafeStringEqual(payload.nonce, tx.nonce)) {
      throw new CloudError('UNAUTHORIZED', 'OIDC id_token nonce mismatch', { status: 401 });
    }

    const sub = readStringClaim(payload, this.cfg.claimSub);
    if (!sub) {
      throw new CloudError('UNAUTHORIZED', 'OIDC id_token missing subject claim', { status: 401 });
    }
    const email = readStringClaim(payload, this.cfg.claimEmail);
    const displayName =
      readStringClaim(payload, this.cfg.claimName) ?? email ?? `User ${sub.slice(0, 8)}`;
    const avatarUrl = readStringClaim(payload, 'picture');
    const externalWorkspaceId = this.cfg.claimWorkspace
      ? readStringClaim(payload, this.cfg.claimWorkspace)
      : null;

    const membership = input.amrIdentity
      ? (
          await input.amrIdentity.resolveAndProjectLogin(store, {
            authUserId: sub,
            email,
            displayName,
            avatarUrl,
            requestedExternalWorkspaceId: externalWorkspaceId,
          })
        ).membership
      : await store.upsertOidcUserAndWorkspace({
          oidcSub: sub,
          email,
          displayName,
          avatarUrl,
          externalWorkspaceId,
        });

    return { membership, returnTo: tx.returnTo };
  }

  /**
   * Verify a Bearer OIDC / delegated OAuth 2.1 JWT via JWKS (`jose`).
   */
  async verifyBearerJwt(
    store: AuthStore,
    token: string,
    options: { expectedAudience?: string | string[]; requestedWorkspaceId?: string | null } = {},
  ): Promise<AuthContext | null> {
    if (!token || token.split('.').length !== 3) return null;

    const doc = await this.discover();
    const jwks = await this.getJwks();
    if (!jwks) return null;
    const audience = options.expectedAudience ?? this.cfg.audience ?? this.cfg.clientId;

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, jwks, {
        issuer: doc.issuer,
        ...(audience ? { audience } : {}),
        algorithms: [...ASYMMETRIC_OIDC_ALGS],
      });
      payload = verified.payload;
    } catch {
      return null;
    }

    const sub = readStringClaim(payload, this.cfg.claimSub);
    if (!sub) return null;

    const email = readStringClaim(payload, this.cfg.claimEmail);
    const displayName =
      readStringClaim(payload, this.cfg.claimName) ?? email ?? `User ${sub.slice(0, 8)}`;
    const externalWorkspaceId = this.cfg.claimWorkspace
      ? readStringClaim(payload, this.cfg.claimWorkspace)
      : null;

    if (options.requestedWorkspaceId && !isUuid(options.requestedWorkspaceId)) {
      throw new CloudError('INVALID_ARGUMENT', 'Invalid workspace ID', { status: 400 });
    }

    let membership: MembershipResolution | null = null;
    const existingUser = await store.findUserByOidcSub(sub);
    if (options.requestedWorkspaceId) {
      membership = existingUser
        ? await store.findMembership(options.requestedWorkspaceId, existingUser.id)
        : null;
      if (!membership) {
        throw new CloudError(
          'WORKSPACE_FORBIDDEN',
          'You do not have access to the requested workspace.',
          { status: 403 },
        );
      }
    }
    if (!membership) {
      membership = await store.upsertOidcUserAndWorkspace({
        oidcSub: sub,
        email,
        displayName,
        externalWorkspaceId,
      });
    }

    // Parse optional explicit scope claim; intersect strictly with member role ceiling.
    const rawScope = typeof payload.scope === 'string' ? payload.scope : null;
    let scopes: PatScope[];
    if (rawScope !== null) {
      const parsed = rawScope
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(isValidPatScope);
      scopes = intersectScopesWithRole(parsed, membership.role);
    } else {
      scopes = [...roleAllowedScopes(membership.role)];
    }

    return {
      workspaceId: membership.workspace.id,
      userId: membership.user.id,
      role: membership.role,
      scopes,
      authMode: 'oidc',
      authMethod: 'oidc_jwt',
      externalWorkspaceId: membership.workspace.externalWorkspaceId,
      tokenId: typeof payload.jti === 'string' ? payload.jti : undefined,
      email: membership.user.email,
      displayName: membership.user.displayName,
    };
  }
}
