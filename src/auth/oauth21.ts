import {
  DEFAULT_PAT_SCOPES,
  type AuthContext,
  type AuthMode,
  type PatScope,
} from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { AppConfig } from '../infra/config.ts';
import { verifyPkceS256 } from './oidc.ts';
import {
  intersectScopesWithRole,
  isValidPatScope,
  randomBase64Url,
  randomHex,
  sha256Hex,
  timingSafeStringEqual,
  type AuthKeyValueCache,
  type AuthStore,
  type OAuthAuthMethod,
  type OAuthClientRecord,
} from './store.ts';

export const OAUTH_ACCESS_TOKEN_PREFIX = 'om_oat_';
export const OAUTH_REFRESH_TOKEN_PREFIX = 'om_ort_';
const AUTH_CODE_TTL_SEC = 300; // 5 minutes
const ACCESS_TOKEN_TTL_SEC = 3600; // 1 hour
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const OAUTH_TOUCH_THROTTLE_SEC = 60;
// Concurrent refreshes from one client lose the rotation race within this window; that is not theft.
const REFRESH_REUSE_GRACE_SEC = 30;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export const DEFAULT_DCR_ALLOWED_HTTPS_HOSTS: readonly string[] = ['chatgpt.com', 'claude.ai'];

export type McpOAuthMode = 'proxy' | 'delegated';

export interface OAuth21Config {
  mode: McpOAuthMode;
  publicOrigin: string;
  issuer: string;
  resourceUrl: string;
  resourceMetadataUrl: string;
  supportedScopes: readonly PatScope[];
  allowedHttpsHosts: readonly string[];
  dcrRateLimitPerMin: number;
}

export function parseAllowedHttpsHosts(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [...DEFAULT_DCR_ALLOWED_HTTPS_HOSTS];
  const hosts: string[] = [];
  for (const part of raw.split(',')) {
    const cleaned = part.trim().toLowerCase();
    if (cleaned && !hosts.includes(cleaned)) hosts.push(cleaned);
  }
  return hosts;
}

export function buildOAuth21Config(
  config: Pick<
    AppConfig,
    'APP_PUBLIC_ORIGIN' | 'MCP_OAUTH_MODE' | 'MCP_OAUTH_ISSUER' | 'OIDC_ISSUER'
  > &
    Partial<Pick<AppConfig, 'OAUTH_DCR_ALLOWED_HTTPS_HOSTS' | 'OAUTH_DCR_RATE_LIMIT_PER_MIN'>>,
): OAuth21Config {
  const publicOrigin = config.APP_PUBLIC_ORIGIN.replace(/\/$/, '');
  const resourceUrl = `${publicOrigin}/mcp`;
  const resourceMetadataUrl = `${publicOrigin}/.well-known/oauth-protected-resource/mcp`;
  const issuer = (
    config.MCP_OAUTH_ISSUER ??
    (config.MCP_OAUTH_MODE === 'delegated' && config.OIDC_ISSUER
      ? config.OIDC_ISSUER
      : publicOrigin)
  ).replace(/\/$/, '');

  return {
    mode: config.MCP_OAUTH_MODE,
    publicOrigin,
    issuer,
    resourceUrl,
    resourceMetadataUrl,
    supportedScopes: [...DEFAULT_PAT_SCOPES],
    allowedHttpsHosts: parseAllowedHttpsHosts(config.OAUTH_DCR_ALLOWED_HTTPS_HOSTS),
    dcrRateLimitPerMin: config.OAUTH_DCR_RATE_LIMIT_PER_MIN ?? 10,
  };
}

/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata document.
 */
export function buildProtectedResourceMetadata(cfg: OAuth21Config): Record<string, unknown> {
  return {
    resource: cfg.resourceUrl,
    authorization_servers: [cfg.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [...cfg.supportedScopes],
    resource_name: 'OpenDesign Workbench MCP',
  };
}

/**
 * RFC 8414 OAuth 2.0 Authorization Server Metadata document (proxy mode).
 */
export function buildAuthorizationServerMetadata(cfg: OAuth21Config): Record<string, unknown> {
  const base = cfg.publicOrigin;
  return {
    issuer: cfg.issuer,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [...cfg.supportedScopes],
  };
}

export function normalizeResourceUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function isLoopbackRedirectUri(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function formatRedirectHostLabel(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      return `Local application (${parsed.hostname})`;
    }
    return parsed.host;
  } catch {
    return raw;
  }
}

export function isAllowedOAuthRedirectUri(
  raw: string,
  allowedHttpsHosts: readonly string[] = DEFAULT_DCR_ALLOWED_HTTPS_HOSTS,
): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.hash || parsed.username || parsed.password) return false;
  if (parsed.protocol === 'https:') {
    const host = parsed.hostname.toLowerCase();
    if (!host) return false;
    return allowedHttpsHosts.some((allowed) => {
      const target = allowed.trim().toLowerCase();
      if (!target) return false;
      if (target.startsWith('*.')) {
        const suffix = target.slice(1);
        return host.endsWith(suffix) && host.length > suffix.length;
      }
      return host === target;
    });
  }
  if (parsed.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  }
  return false;
}

export function isOAuthAccessToken(token: string): boolean {
  return token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) && token.length >= 40;
}

export function parseScopeString(raw: string | null | undefined, fallback: readonly PatScope[]): PatScope[] {
  if (!raw || !raw.trim()) return [...fallback];
  const scopes: PatScope[] = [];
  for (const part of raw.trim().split(/\s+/)) {
    if (isValidPatScope(part) && !scopes.includes(part)) {
      scopes.push(part);
    }
  }
  return scopes.length > 0 ? scopes : [...fallback];
}

// ---------------------------------------------------------------------------
// RFC 7591 Dynamic Client Registration
// ---------------------------------------------------------------------------

export interface RegisterClientInput {
  client_name?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  token_endpoint_auth_method?: unknown;
}

export interface RegisterClientResult {
  client_id: string;
  client_secret?: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: OAuthAuthMethod;
  client_id_issued_at: number;
}

export async function registerOAuthClient(
  store: AuthStore,
  input: RegisterClientInput,
  options: { allowedHttpsHosts?: readonly string[] } = {},
): Promise<RegisterClientResult> {
  const clientName =
    typeof input.client_name === 'string' && input.client_name.trim().length > 0
      ? input.client_name.trim().slice(0, 160)
      : 'MCP Client';

  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0 || input.redirect_uris.length > 10) {
    throw new CloudError('INVALID_ARGUMENT', 'redirect_uris must be a non-empty array (max 10)', {
      status: 400,
    });
  }
  const allowedHttpsHosts = options.allowedHttpsHosts ?? DEFAULT_DCR_ALLOWED_HTTPS_HOSTS;
  const redirectUris: string[] = [];
  for (const uri of input.redirect_uris) {
    if (typeof uri !== 'string' || !isAllowedOAuthRedirectUri(uri, allowedHttpsHosts)) {
      throw new CloudError(
        'INVALID_ARGUMENT',
        'redirect_uris must contain only loopback HTTP URIs or allowlisted HTTPS hosts without fragments',
        { status: 400 },
      );
    }
    if (!redirectUris.includes(uri)) redirectUris.push(uri);
  }

  const allowedAuthMethods: readonly OAuthAuthMethod[] = [
    'none',
    'client_secret_post',
    'client_secret_basic',
  ];
  const authMethod: OAuthAuthMethod =
    typeof input.token_endpoint_auth_method === 'string' &&
    allowedAuthMethods.includes(input.token_endpoint_auth_method as OAuthAuthMethod)
      ? (input.token_endpoint_auth_method as OAuthAuthMethod)
      : 'none';

  const supportedGrants = new Set(['authorization_code', 'refresh_token']);
  const requestedGrants = Array.isArray(input.grant_types)
    ? input.grant_types.filter((g): g is string => typeof g === 'string' && supportedGrants.has(g))
    : ['authorization_code', 'refresh_token'];
  const grantTypes =
    requestedGrants.length > 0 ? [...new Set(requestedGrants)] : ['authorization_code', 'refresh_token'];

  const clientId = `om_client_${randomHex(12)}`;
  const rawSecret = authMethod === 'none' ? null : `om_csec_${randomBase64Url(32)}`;
  const clientSecretHash = rawSecret ? sha256Hex(rawSecret) : null;

  const created = await store.createOAuthClient({
    clientId,
    clientSecretHash,
    clientName,
    redirectUris,
    grantTypes,
    tokenEndpointAuthMethod: authMethod,
  });

  return {
    client_id: created.clientId,
    ...(rawSecret ? { client_secret: rawSecret } : {}),
    client_name: created.clientName,
    redirect_uris: created.redirectUris,
    grant_types: created.grantTypes,
    token_endpoint_auth_method: created.tokenEndpointAuthMethod,
    client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
  };
}

// ---------------------------------------------------------------------------
// Authorization Code Validation & Issuance (OAuth 2.1 + Mandatory PKCE S256)
// ---------------------------------------------------------------------------

export interface ValidatedAuthorizeParams {
  client: OAuthClientRecord;
  redirectUri: string;
  state: string | null;
  scope: string;
  scopes: PatScope[];
  codeChallenge: string;
  resource: string | null;
}

export async function validateAuthorizeRequest(
  store: AuthStore,
  cfg: OAuth21Config,
  params: {
    clientId?: string | null;
    redirectUri?: string | null;
    responseType?: string | null;
    codeChallenge?: string | null;
    codeChallengeMethod?: string | null;
    scope?: string | null;
    state?: string | null;
    resource?: string | null;
  },
): Promise<ValidatedAuthorizeParams> {
  if (!params.clientId) {
    throw new CloudError('INVALID_ARGUMENT', 'client_id is required', { status: 400 });
  }
  const client = await store.findOAuthClient(params.clientId);
  if (!client) {
    throw new CloudError('INVALID_ARGUMENT', 'Unknown OAuth client_id', { status: 400 });
  }
  if (!params.redirectUri || !client.redirectUris.includes(params.redirectUri)) {
    throw new CloudError('INVALID_ARGUMENT', 'redirect_uri does not match registered client', {
      status: 400,
    });
  }
  if (params.responseType !== 'code') {
    throw new CloudError('INVALID_ARGUMENT', 'response_type must be code', { status: 400 });
  }
  if (!params.codeChallenge || params.codeChallenge.length < 43 || params.codeChallenge.length > 128) {
    throw new CloudError('INVALID_ARGUMENT', 'PKCE code_challenge is required', { status: 400 });
  }
  if (params.codeChallengeMethod !== 'S256') {
    throw new CloudError('INVALID_ARGUMENT', 'OAuth 2.1 requires code_challenge_method=S256', {
      status: 400,
    });
  }

  let normalizedResource: string | null = null;
  if (params.resource) {
    normalizedResource = normalizeResourceUrl(params.resource);
    const expectedResource = normalizeResourceUrl(cfg.resourceUrl);
    if (!normalizedResource || normalizedResource !== expectedResource) {
      throw new CloudError('INVALID_ARGUMENT', 'Invalid RFC 8707 resource parameter', {
        status: 400,
      });
    }
  }

  // Self-registered MCP clients must never be granted workspace:admin.
  const scopes = parseScopeString(params.scope, cfg.supportedScopes).filter(
    (s) => s !== 'workspace:admin',
  );
  const safeScopes = scopes.length > 0 ? scopes : [...cfg.supportedScopes];
  return {
    client,
    redirectUri: params.redirectUri,
    state: params.state ?? null,
    scope: safeScopes.join(' '),
    scopes: safeScopes,
    codeChallenge: params.codeChallenge,
    resource: normalizedResource ?? normalizeResourceUrl(cfg.resourceUrl),
  };
}

export async function issueAuthorizationCode(
  store: AuthStore,
  auth: AuthContext,
  validated: ValidatedAuthorizeParams,
  options: { issuer?: string } = {},
): Promise<{ code: string; redirectUrl: string }> {
  const effectiveScopes = intersectScopesWithRole(validated.scopes, auth.role).filter(
    (s) => s !== 'workspace:admin',
  );
  if (effectiveScopes.length === 0) {
    throw new CloudError('FORBIDDEN', 'No requested scopes are permitted for your workspace role', {
      status: 403,
    });
  }

  const code = randomBase64Url(32);
  const codeHash = sha256Hex(code);
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000);

  await store.createOAuthAuthCode({
    codeHash,
    clientId: validated.client.clientId,
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    redirectUri: validated.redirectUri,
    scope: effectiveScopes.join(' '),
    codeChallenge: validated.codeChallenge,
    resource: validated.resource,
    expiresAt,
  });

  const redirect = new URL(validated.redirectUri);
  redirect.searchParams.set('code', code);
  if (validated.state) {
    redirect.searchParams.set('state', validated.state);
  }
  if (options.issuer) {
    redirect.searchParams.set('iss', options.issuer);
  }
  return { code, redirectUrl: redirect.toString() };
}

// ---------------------------------------------------------------------------
// Token Exchange & Rotation (`POST /oauth/token`)
// ---------------------------------------------------------------------------

export interface OAuthTokenRequest {
  grantType: string;
  code?: string;
  redirectUri?: string;
  codeVerifier?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  resource?: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function authenticateOAuthClient(
  client: OAuthClientRecord,
  suppliedSecret?: string,
): void {
  if (client.tokenEndpointAuthMethod === 'none') return;
  if (!suppliedSecret || !client.clientSecretHash) {
    throw new CloudError('UNAUTHORIZED', 'invalid_client', { status: 401 });
  }
  if (!timingSafeStringEqual(sha256Hex(suppliedSecret), client.clientSecretHash)) {
    throw new CloudError('UNAUTHORIZED', 'invalid_client', { status: 401 });
  }
}

export async function exchangeOAuthToken(
  store: AuthStore,
  cfg: OAuth21Config,
  req: OAuthTokenRequest,
): Promise<OAuthTokenResponse> {
  if (!req.clientId) {
    throw new CloudError('INVALID_ARGUMENT', 'client_id is required', { status: 400 });
  }
  const client = await store.findOAuthClient(req.clientId);
  if (!client) {
    throw new CloudError('UNAUTHORIZED', 'invalid_client', { status: 401 });
  }
  authenticateOAuthClient(client, req.clientSecret);

  if (req.grantType === 'authorization_code') {
    if (!req.code || !req.redirectUri || !req.codeVerifier) {
      throw new CloudError('INVALID_ARGUMENT', 'code, redirect_uri, and code_verifier are required', {
        status: 400,
      });
    }
    const consumed = await store.consumeOAuthAuthCode(sha256Hex(req.code));
    if (!consumed) {
      throw new CloudError('INVALID_ARGUMENT', 'invalid_grant: authorization code expired or already used', {
        status: 400,
      });
    }
    if (consumed.clientId !== client.clientId || consumed.redirectUri !== req.redirectUri) {
      throw new CloudError('INVALID_ARGUMENT', 'invalid_grant: client or redirect_uri mismatch', {
        status: 400,
      });
    }
    if (!verifyPkceS256(req.codeVerifier, consumed.codeChallenge)) {
      throw new CloudError('INVALID_ARGUMENT', 'invalid_grant: PKCE verification failed', {
        status: 400,
      });
    }
    if (req.resource && consumed.resource) {
      if (normalizeResourceUrl(req.resource) !== normalizeResourceUrl(consumed.resource)) {
        throw new CloudError('INVALID_ARGUMENT', 'invalid_target: resource mismatch', {
          status: 400,
        });
      }
    }

    return mintOAuthTokenPair(store, {
      clientId: client.clientId,
      userId: consumed.userId,
      workspaceId: consumed.workspaceId,
      scope: consumed.scope,
      resource: consumed.resource ?? normalizeResourceUrl(cfg.resourceUrl),
    });
  }

  if (req.grantType === 'refresh_token') {
    if (!req.refreshToken) {
      throw new CloudError('INVALID_ARGUMENT', 'refresh_token is required', { status: 400 });
    }
    const refreshHash = sha256Hex(req.refreshToken);
    const existing = await store.findActiveOAuthTokenByRefreshHash(refreshHash);
    if (!existing || existing.clientId !== client.clientId) {
      await revokeConnectionOnRefreshReuse(store, refreshHash, client.clientId);
      throw new CloudError('INVALID_ARGUMENT', 'invalid_grant: refresh token is invalid or expired', {
        status: 400,
      });
    }
    // Rotate refresh token atomically: revoke previous row before issuing a fresh pair.
    const revoked = await store.revokeOAuthTokenById(existing.id);
    if (!revoked) {
      throw new CloudError(
        'INVALID_ARGUMENT',
        'invalid_grant: refresh token already used or revoked',
        { status: 400 },
      );
    }

    return mintOAuthTokenPair(store, {
      clientId: client.clientId,
      userId: existing.userId,
      workspaceId: existing.workspaceId,
      scope: existing.scope,
      resource: existing.resource,
    });
  }

  throw new CloudError('INVALID_ARGUMENT', 'unsupported_grant_type', { status: 400 });
}

/**
 * RFC 9700 §4.14.2: a refresh token presented again after rotation means a copy leaked, and the
 * server cannot tell the attacker from the client, so every live token of that connection is revoked.
 * Only rotation keeps the refresh hash on a revoked row; explicitly revoked tokens no longer match.
 * Project grants stay; the user only has to authorize the client again.
 */
async function revokeConnectionOnRefreshReuse(
  store: AuthStore,
  refreshHash: string,
  clientId: string,
): Promise<void> {
  const prior = await store.findOAuthTokenByRefreshHash(refreshHash);
  if (!prior?.revokedAt || prior.clientId !== clientId) return;
  if (!prior.refreshExpiresAt || prior.refreshExpiresAt.getTime() <= Date.now()) return;
  if (Date.now() - prior.revokedAt.getTime() < REFRESH_REUSE_GRACE_SEC * 1000) return;
  await store.revokeOAuthClientForUser(prior.userId, prior.clientId);
}

async function mintOAuthTokenPair(
  store: AuthStore,
  input: {
    clientId: string;
    userId: string;
    workspaceId: string;
    scope: string;
    resource: string | null;
  },
): Promise<OAuthTokenResponse> {
  const accessToken = `${OAUTH_ACCESS_TOKEN_PREFIX}${randomBase64Url(36)}`;
  const refreshToken = `${OAUTH_REFRESH_TOKEN_PREFIX}${randomBase64Url(36)}`;
  const now = Date.now();
  const accessExpiresAt = new Date(now + ACCESS_TOKEN_TTL_SEC * 1000);
  const refreshExpiresAt = new Date(now + REFRESH_TOKEN_TTL_SEC * 1000);

  await store.createOAuthToken({
    clientId: input.clientId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    accessTokenHash: sha256Hex(accessToken),
    refreshTokenHash: sha256Hex(refreshToken),
    scope: input.scope,
    resource: input.resource,
    accessExpiresAt,
    refreshExpiresAt,
  });

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: refreshToken,
    scope: input.scope,
  };
}

export async function revokeOAuthToken(store: AuthStore, token: string): Promise<void> {
  if (!token) return;
  await store.revokeOAuthTokenByHash(sha256Hex(token));
}

/**
 * Verify an OAuth 2.1 access token stored in PG `oauth_tokens`.
 * Enforces revocation, expiry, RFC 8707 resource binding, live membership, and strict scope intersection.
 */
export async function verifyOAuthAccessToken(
  store: AuthStore,
  rawToken: string,
  options: { authMode: AuthMode; expectedResource: string; cache?: AuthKeyValueCache },
): Promise<AuthContext | null> {
  if (!isOAuthAccessToken(rawToken)) return null;
  const computedHash = sha256Hex(rawToken);
  const row = await store.findActiveOAuthTokenByAccessHash(computedHash);
  if (!row) return null;
  if (!timingSafeStringEqual(computedHash, row.accessTokenHash)) return null;

  if (row.resource) {
    const expected = normalizeResourceUrl(options.expectedResource);
    const actual = normalizeResourceUrl(row.resource);
    if (!expected || !actual || expected !== actual) return null;
  }

  const membership = await store.findMembership(row.workspaceId, row.userId);
  if (!membership) return null;

  const tokenScopes = parseScopeString(row.scope, []).filter((s) => s !== 'workspace:admin');
  const effectiveScopes = intersectScopesWithRole(tokenScopes, membership.role);

  const touchKey = `om:oauth:touch:${row.id}`;
  if (options.cache) {
    const recentlyTouched = await options.cache.get(touchKey);
    if (!recentlyTouched) {
      await options.cache.set(touchKey, '1', OAUTH_TOUCH_THROTTLE_SEC);
      void store.touchOAuthToken(row.id).catch(() => {});
    }
  } else {
    void store.touchOAuthToken(row.id).catch(() => {});
  }

  return {
    workspaceId: membership.workspace.id,
    userId: membership.user.id,
    role: membership.role,
    scopes: effectiveScopes,
    authMode: options.authMode,
    authMethod: 'oauth_bearer',
    entry: 'mcp',
    clientId: row.clientId,
    externalWorkspaceId: membership.workspace.externalWorkspaceId,
    authUserId: membership.user.oidcSub,
    appUserId: membership.user.appUserId ?? null,
    tokenId: row.id,
    email: membership.user.email,
    displayName: membership.user.displayName,
    avatarUrl: membership.user.avatarUrl,
  };
}

// ---------------------------------------------------------------------------
// Escaped HTML Consent Page for OAuth 2.1 Proxy Mode (OpenDesign Workbench)
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const SCOPE_DESCRIPTIONS: Readonly<Record<string, { title: string; detail: string }>> = {
  'projects:read': { title: '查看已授权的视频项目', detail: '读取画面、时间轴与版本历史' },
  'projects:write': { title: '编辑已授权的视频项目', detail: '修改场景、文案、动画并保存版本' },
  'assets:read': { title: '读取工作区素材', detail: '访问素材库与项目中的媒体文件' },
  'assets:write': { title: '上传与导入工作区素材', detail: '导入新的图片、音频和视频素材' },
  'exports:write': { title: '发起视频渲染与导出', detail: '提交导出任务并下载成片' },
  'media:generate': { title: '调用 AI 模型生成素材', detail: '生成图片、视频、配音和音乐' },
  'mcp:tools': { title: '通过 MCP 连接 OpenMotion', detail: '在当前 Agent 中调用云端创作工具' },
};

interface ConsentPermissionGroup {
  title: string;
  detail: string;
}

function summarizeConsentScopes(scopes: readonly string[]): ConsentPermissionGroup[] {
  const remaining = new Set(scopes);
  const groups: ConsentPermissionGroup[] = [];

  if (remaining.has('projects:read') && remaining.has('projects:write')) {
    remaining.delete('projects:read');
    remaining.delete('projects:write');
    groups.push({
      title: '查看并编辑已授权的视频项目',
      detail: '仅限该应用新建及你在网页中手动授权的项目',
    });
  }

  if (remaining.has('assets:read') && remaining.has('assets:write')) {
    remaining.delete('assets:read');
    remaining.delete('assets:write');
    groups.push({
      title: '读取与导入工作区素材',
      detail: '访问素材库并上传图片、视频和音频文件',
    });
  }

  if (remaining.has('media:generate') && remaining.has('exports:write')) {
    remaining.delete('media:generate');
    remaining.delete('exports:write');
    groups.push({
      title: 'AI 生成素材与渲染导出视频',
      detail: '调用平台模型生成媒体并发起成片导出',
    });
  }

  for (const scope of scopes) {
    if (!remaining.has(scope)) continue;
    remaining.delete(scope);
    const desc = SCOPE_DESCRIPTIONS[scope];
    groups.push(desc ?? { title: scope, detail: '请求此工作区权限' });
  }

  return groups;
}

const OPENDESIGN_MARK_SVG = `<svg viewBox="0 0 291 291" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M145.5 0C225.857 0 291 65.1426 291 145.5C291 225.857 225.857 291 145.5 291H19.3581C8.64385 291 0.000681982 282.358 0.000616442 271.644C0.000417939 239.193 1.50624e-09 174.523 0 145.5C0 65.1426 65.1426 5.2069e-06 145.5 0ZM145.501 29.1004C81.2147 29.1004 29.1004 81.2147 29.1004 145.501C29.1005 209.786 81.2147 261.9 145.501 261.9C209.786 261.9 261.9 209.786 261.9 145.501C261.9 81.2147 209.786 29.1004 145.501 29.1004Z" fill="currentColor"/><path d="M137.934 215.04L94.3119 100.247C92.9002 96.5317 96.5286 92.8895 100.219 94.3172L215.067 138.749C219.793 140.578 218.491 147.633 213.427 147.633H146.769V213.4C146.769 218.499 139.744 219.804 137.934 215.04Z" fill="currentColor"/></svg>`;

const MCP_CLIENT_GLYPH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>`;

const CHECK_ICON_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>`;

export function renderOAuthConsentHtml(input: {
  clientName: string;
  redirectUri?: string;
  workspaceName: string;
  workspaceId?: string;
  workspaces?: ReadonlyArray<{ id: string; name: string; role: string }>;
  userEmail?: string | null;
  userDisplayName?: string | null;
  userAvatarUrl?: string | null;
  switchAccountUrl?: string;
  scopes: readonly string[];
  formAction: string;
  hiddenFields: Record<string, string>;
}): string {
  const hiddenInputs = Object.entries(input.hiddenFields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('\n');

  const permissionItems = summarizeConsentScopes(input.scopes)
    .map(
      (item) => `<li class="perm-item">
          <span class="perm-check">${CHECK_ICON_SVG}</span>
          <div class="perm-copy">
            <div class="perm-title">${escapeHtml(item.title)}</div>
            <div class="perm-detail">${escapeHtml(item.detail)}</div>
          </div>
        </li>`,
    )
    .join('\n');

  const rawScopePills = input.scopes
    .map((scope) => `<code class="ui-badge scope-pill">${escapeHtml(scope)}</code>`)
    .join('');

  const redirectHostLabel = input.redirectUri
    ? formatRedirectHostLabel(input.redirectUri)
    : 'Local application';
  const primaryAccountName = input.userDisplayName || input.userEmail || '当前登录账号';
  const secondaryAccountEmail =
    input.userEmail && input.userEmail !== primaryAccountName ? input.userEmail : null;
  const avatarInitial = primaryAccountName.slice(0, 1).toUpperCase();
  const avatarHtml = input.userAvatarUrl
    ? `<img class="avatar-img" src="${escapeHtml(input.userAvatarUrl)}" alt="">`
    : `<span class="avatar-fallback" aria-hidden="true">${escapeHtml(avatarInitial)}</span>`;

  const workspaceControl =
    input.workspaces && input.workspaces.length > 1
      ? `<div class="meta-row meta-row-select">
          <label class="meta-label" for="selected_workspace_id">授权工作区</label>
          <select id="selected_workspace_id" name="selected_workspace_id" class="ui-input ws-select">
            ${input.workspaces
              .map(
                (ws) =>
                  `<option value="${escapeHtml(ws.id)}"${ws.id === input.workspaceId ? ' selected' : ''}>${escapeHtml(ws.name)} (${escapeHtml(ws.role)})</option>`,
              )
              .join('\n')}
          </select>
        </div>`
      : `<div class="meta-row"><span class="meta-label">授权工作区</span><strong class="meta-value">${escapeHtml(input.workspaceName)}</strong></div>`;

  const switchAccountHtml = input.switchAccountUrl
    ? `<a class="ui-text-link switch-link" href="${escapeHtml(input.switchAccountUrl)}">换一个账号</a>`
    : '';

  return `<!doctype html>
<html lang="zh-CN" data-motion-ui>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>授权 ${escapeHtml(input.clientName)} — OpenMotion</title>
  <link rel="icon" href="/design-system/brand/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/design-system/ui.css">
  <style>
    body {
      background-color: var(--motion-shell);
      background-image:
        radial-gradient(680px 340px at 50% -40px, color-mix(in srgb, var(--motion-brand) 9%, transparent), transparent 72%),
        radial-gradient(color-mix(in srgb, var(--motion-strong) 6%, transparent) 1px, transparent 1px);
      background-size: auto, 22px 22px;
      min-height: 100vh;
      padding: var(--motion-space-28) var(--motion-space-16);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .shell {
      width: 100%;
      max-width: 448px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--motion-space-16);
    }
    .brand-bar {
      display: inline-flex;
      align-items: center;
      gap: var(--motion-space-8);
      color: var(--motion-strong);
      font-size: var(--motion-text-body);
      font-weight: var(--motion-weight-bold);
      letter-spacing: -0.015em;
    }
    .brand-bar-mark {
      width: var(--motion-space-20);
      height: var(--motion-space-20);
      color: var(--motion-strong);
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .brand-bar-mark svg { width: 100%; height: 100%; display: block; }
    main {
      width: 100%;
      background: var(--motion-bg);
      border: 1px solid var(--motion-border-subtle);
      border-radius: var(--motion-radius-step-20);
      padding: var(--motion-space-28) var(--motion-space-24) var(--motion-space-24);
      box-shadow: var(--motion-shadow-lg);
    }
    .bridge {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--motion-space-14);
      margin-bottom: var(--motion-space-18);
    }
    .bridge-tile {
      width: var(--motion-space-44);
      height: var(--motion-space-44);
      border-radius: var(--motion-radius-xl);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .bridge-tile-client {
      background: var(--motion-panel);
      color: var(--motion-strong);
      border: 1px solid var(--motion-border);
    }
    .bridge-tile-client svg { width: 22px; height: 22px; }
    .bridge-tile-od {
      background: var(--motion-brand);
      color: var(--motion-on-brand);
      padding: var(--motion-space-8);
      box-shadow: var(--motion-mcp-hero-od-shadow);
    }
    .bridge-tile-od svg { width: 100%; height: 100%; display: block; }
    .bridge-link {
      display: inline-flex;
      align-items: center;
      gap: var(--motion-space-6);
      color: var(--motion-dim);
    }
    .bridge-dash {
      width: var(--motion-space-14);
      height: 1px;
      border-top: 1.5px dashed var(--motion-border-strong);
    }
    .bridge-dot {
      width: 7px;
      height: 7px;
      border-radius: var(--motion-radius-full);
      background: var(--motion-brand);
      box-shadow: var(--motion-mcp-hero-od-shadow);
    }
    h1 {
      margin: 0 0 var(--motion-space-8);
      text-align: center;
      font-size: var(--motion-text-title);
      line-height: var(--motion-leading-tight);
      font-weight: var(--motion-weight-bold);
      letter-spacing: -0.02em;
      color: var(--motion-strong);
    }
    .client-sub {
      margin: 0 0 var(--motion-space-20);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      gap: var(--motion-space-6);
      font-size: var(--motion-text-sm);
      color: var(--motion-muted);
      line-height: var(--motion-leading-body);
      text-align: center;
    }
    .unverified-pill {
      background: var(--motion-panel);
    }
    .card {
      background: var(--motion-panel);
      border: 1px solid var(--motion-border-subtle);
      border-radius: var(--motion-radius-step-14);
      padding: var(--motion-space-12) var(--motion-space-14);
      margin-bottom: var(--motion-space-18);
    }
    .account-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--motion-space-12);
    }
    .account-left {
      display: flex;
      align-items: center;
      gap: var(--motion-space-10);
      min-width: 0;
    }
    .avatar-img, .avatar-fallback {
      width: 34px;
      height: 34px;
      border-radius: var(--motion-radius-full);
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--motion-raised);
      color: var(--motion-strong);
      border: 1px solid var(--motion-border);
      font-weight: var(--motion-weight-semibold);
      font-size: var(--motion-text-md);
      object-fit: cover;
    }
    .account-meta { min-width: 0; }
    .account-name {
      font-size: var(--motion-text-md);
      font-weight: var(--motion-weight-semibold);
      color: var(--motion-strong);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .account-email {
      font-size: var(--motion-text-sm);
      color: var(--motion-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: var(--motion-space-2);
    }
    .switch-link {
      color: var(--motion-accent);
      font-weight: var(--motion-weight-medium);
      flex-shrink: 0;
    }
    .meta-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--motion-space-12);
      margin-top: var(--motion-space-12);
      padding-top: var(--motion-space-12);
      border-top: 1px solid var(--motion-border-subtle);
      font-size: var(--motion-text-md);
    }
    .meta-row-select {
      flex-direction: column;
      align-items: stretch;
      gap: var(--motion-space-6);
    }
    .meta-label { color: var(--motion-muted); flex-shrink: 0; }
    .meta-value {
      color: var(--motion-strong);
      font-weight: var(--motion-weight-semibold);
      text-align: right;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ws-select {
      background: var(--motion-bg);
      border-radius: var(--motion-radius-lg);
    }
    .section-title {
      font-size: var(--motion-text-sm);
      font-weight: var(--motion-weight-semibold);
      color: var(--motion-muted);
      margin: 0 0 var(--motion-space-10);
    }
    .perm-list {
      list-style: none;
      padding: 0;
      margin: 0 0 var(--motion-space-12);
      display: flex;
      flex-direction: column;
      gap: var(--motion-space-10);
    }
    .perm-item {
      display: flex;
      align-items: flex-start;
      gap: var(--motion-space-10);
    }
    .perm-check {
      width: var(--motion-space-18);
      height: var(--motion-space-18);
      border-radius: var(--motion-radius-full);
      background: var(--motion-accent-soft);
      color: var(--motion-accent);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: var(--motion-space-2);
    }
    .perm-check svg { width: 11px; height: 11px; }
    .perm-copy { min-width: 0; }
    .perm-title {
      font-size: var(--motion-text-md);
      font-weight: var(--motion-weight-semibold);
      color: var(--motion-strong);
      line-height: var(--motion-leading-tight);
    }
    .perm-detail {
      font-size: var(--motion-text-sm);
      color: var(--motion-muted);
      line-height: var(--motion-leading-body);
      margin-top: var(--motion-space-2);
    }
    .scope-details {
      margin: 0 0 var(--motion-space-16);
      font-size: var(--motion-text-sm);
      color: var(--motion-dim);
    }
    .scope-details summary {
      cursor: pointer;
      user-select: none;
      list-style: none;
      display: inline-flex;
      align-items: center;
      gap: var(--motion-space-4);
      color: var(--motion-muted);
      font-size: var(--motion-text-sm);
    }
    .scope-details summary:focus-visible {
      outline: 1px solid var(--motion-focus);
      outline-offset: 1px;
    }
    .scope-details summary::-webkit-details-marker { display: none; }
    .scope-details summary::before {
      content: "▸";
      font-size: var(--motion-text-step-10);
      transition: transform var(--motion-duration-fast) var(--motion-ease-out);
    }
    .scope-details[open] summary::before { transform: rotate(90deg); }
    .scope-pills {
      display: flex;
      flex-wrap: wrap;
      gap: var(--motion-space-6);
      margin-top: var(--motion-space-8);
    }
    .scope-pill {
      background: var(--motion-panel);
      border-radius: var(--motion-radius-md);
    }
    .note {
      font-size: var(--motion-text-sm);
      color: var(--motion-muted);
      line-height: var(--motion-leading-body);
      margin: 0 0 var(--motion-space-18);
      padding-top: var(--motion-space-12);
      border-top: 1px solid var(--motion-border-subtle);
    }
    .actions {
      display: flex;
      gap: var(--motion-space-10);
    }
    .consent-action {
      flex: 1;
      min-height: var(--motion-space-44);
      border-radius: var(--motion-radius-pill);
      font-size: var(--motion-text-body);
    }
    .foot-caption {
      font-size: var(--motion-text-xs);
      color: var(--motion-dim);
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="brand-bar">
      <span class="brand-bar-mark">${OPENDESIGN_MARK_SVG}</span>
      <span>OpenMotion</span>
    </div>
    <main>
      <div class="bridge" aria-hidden="true">
        <span class="bridge-tile bridge-tile-client">${MCP_CLIENT_GLYPH_SVG}</span>
        <span class="bridge-link">
          <span class="bridge-dash"></span>
          <span class="bridge-dot"></span>
          <span class="bridge-dash"></span>
        </span>
        <span class="bridge-tile bridge-tile-od">${OPENDESIGN_MARK_SVG}</span>
      </div>
      <h1>授权 ${escapeHtml(input.clientName)} 连接 OpenMotion</h1>
      <p class="client-sub">
        <span class="ui-badge unverified-pill">应用名未经验证</span>
        <span>·</span>
        <span>回调至 ${escapeHtml(redirectHostLabel)}</span>
      </p>
      <form method="POST" action="${escapeHtml(input.formAction)}">
        ${hiddenInputs}
        <div class="card">
          <div class="account-row">
            <div class="account-left">
              ${avatarHtml}
              <div class="account-meta">
                <div class="account-name">${escapeHtml(primaryAccountName)}</div>
                ${secondaryAccountEmail ? `<div class="account-email">${escapeHtml(secondaryAccountEmail)}</div>` : ''}
              </div>
            </div>
            ${switchAccountHtml}
          </div>
          ${workspaceControl}
        </div>
        <div class="section-title">此应用将获得以下权限</div>
        <ul class="perm-list">${permissionItems}</ul>
        ${input.scopes.length > 0 ? `<details class="scope-details"><summary>查看详细权限标识 (${input.scopes.length})</summary><div class="scope-pills">${rawScopePills}</div></details>` : ''}
        <div class="note">同意后即可返回 Agent 继续；新建项目自动可用，已有项目需单独授权，可随时在「设置 → 已连接的应用」撤销。</div>
        <div class="actions">
          <button class="ui-button consent-action" type="submit" name="decision" value="deny">拒绝</button>
          <button class="ui-button ui-button--primary consent-action" type="submit" name="decision" value="approve">同意授权</button>
        </div>
      </form>
    </main>
    <div class="foot-caption">OpenDesign · Cloud MCP OAuth 2.1</div>
  </div>
</body>
</html>`;
}
