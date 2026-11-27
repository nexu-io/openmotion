import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import {
  DEFAULT_PAT_SCOPES,
  PAT_SCOPES,
  hasScope,
} from '../../src/contracts/auth.ts';
import { parseConfig, type AppConfig } from '../../src/infra/config.ts';
import {
  InMemoryAuthCache,
  InMemoryAuthStore,
  OidcService,
  SESSION_COOKIE_NAME,
  buildOAuth21Config,
  createAuthMiddleware,
  createAuthRoutes,
  createBrowserSession,
  createMcpBearerAuthMiddleware,
  createPat,
  exchangeOAuthToken,
  generatePkcePair,
  getAuthContext,
  registerOAuthClient,
  requireScope,
  revokeOAuthToken,
  sha256Hex,
  verifyPat,
  type AuthEnv,
} from '../../src/auth/index.ts';

// ---------------------------------------------------------------------------
// Test Config & Ephemeral RSA Keypair Helpers (Zero Static Keys on Disk!)
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    WORKER_ROLE: 'api',
    APP_PUBLIC_ORIGIN: 'https://motion.example.test',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example.test',
    OIDC_CLIENT_ID: 'openmotion-cloud-client',
    OIDC_CLIENT_SECRET: 'ephemeral-test-client-secret',
    SESSION_SECRET: '0'.repeat(32),
    MODEL_GATEWAY_MODE: 'mock',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  });
}

async function createEphemeralOidcFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = await exportJWK(publicKey);
  const kid = 'ephemeral-test-kid-1';
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const jwks = createLocalJWKSet({ keys: [publicJwk] });

  async function signJwt(
    claims: Record<string, unknown>,
    options: { issuer?: string; audience?: string; expiresIn?: string } = {},
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuedAt()
      .setIssuer(options.issuer ?? 'https://idp.example.test')
      .setAudience(options.audience ?? 'openmotion-cloud-client')
      .setExpirationTime(options.expiresIn ?? '1h')
      .sign(privateKey);
  }

  return { jwks, signJwt };
}

function extractCookieValue(setCookieHeaders: string[], name: string): string | null {
  for (const header of setCookieHeaders) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(header.trim());
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe('AUTH_MODE=dev Auto-Provisioning & /mcp Bearer Isolation', () => {
  it('auto-provisions deterministic dev tenant for browser API and enforces DEV_PAT / no-cookie rules on /mcp', async () => {
    const config = makeConfig({
      APP_PUBLIC_ORIGIN: 'http://127.0.0.1:4173',
      AUTH_MODE: 'dev',
      DEV_PAT: 'om_pat_devlocal_123456789012345678901234',
    });
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();

    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache }));
    app.post('/mcp', createMcpBearerAuthMiddleware({ config, store, cache }), (c) => {
      const auth = getAuthContext(c);
      return c.json({ ok: true, workspaceId: auth.workspaceId, authMethod: auth.authMethod });
    });

    // Browser API auto-provisions deterministic DEV_WORKSPACE_ID + DEV_USER_ID
    const meRes = await app.request('/auth/me');
    assert.equal(meRes.status, 200);
    const me = (await meRes.json()) as {
      authMode: string;
      authMethod: string;
      activeWorkspaceId: string;
      user: { id: string };
    };
    assert.equal(me.authMode, 'dev');
    assert.equal(me.authMethod, 'dev_bypass');
    assert.equal(me.activeWorkspaceId, config.DEV_WORKSPACE_ID);
    assert.equal(me.user.id, config.DEV_USER_ID);

    // /mcp accepts DEV_PAT Bearer token
    const devPatRes = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.DEV_PAT}` },
    });
    assert.equal(devPatRes.status, 200);

    // /mcp rejects invalid Bearer token even in dev mode
    const badBearer = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(badBearer.status, 401);
    assert.match(
      badBearer.headers.get('www-authenticate') ?? '',
      /resource_metadata="http:\/\/127\.0\.0\.1:4173\/\.well-known\/oauth-protected-resource\/mcp"/,
    );

    // /mcp NEVER accepts browser om_session cookie even in dev mode
    const session = await createBrowserSession(store, {
      userId: config.DEV_USER_ID,
      workspaceId: config.DEV_WORKSPACE_ID,
    });
    const cookieOnMcp = await app.request('/mcp', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
    });
    assert.equal(cookieOnMcp.status, 401);
  });
});

describe('AUTH_MODE=oidc Authorization Code + PKCE, Browser Sessions, CSRF & JWKS Bearer', () => {
  it('completes OIDC Auth Code + PKCE login, sets Secure HttpOnly cookie, enforces CSRF Origin, and revokes authoritatively on logout', async () => {
    const config = makeConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();
    const { jwks, signJwt } = await createEphemeralOidcFixture();

    let capturedCodeVerifier = '';
    let capturedNonce = '';
    const oidc = new OidcService(
      {
        issuer: 'https://idp.example.test',
        clientId: 'openmotion-cloud-client',
        clientSecret: 'ephemeral-test-client-secret',
        callbackUrl: 'https://motion.example.test/auth/callback',
        scopes: 'openid profile email',
        claimSub: 'sub',
        claimEmail: 'email',
        claimName: 'name',
        discovery: {
          issuer: 'https://idp.example.test',
          authorization_endpoint: 'https://idp.example.test/authorize',
          token_endpoint: 'https://idp.example.test/token',
          jwks_uri: 'https://idp.example.test/jwks.json',
          end_session_endpoint: 'https://idp.example.test/logout',
        },
        jwks,
        fetcher: async (_url, init) => {
          const body = new URLSearchParams(String(init?.body ?? ''));
          capturedCodeVerifier = body.get('code_verifier') ?? '';
          const idToken = await signJwt({
            sub: 'opendesign-user-42',
            email: 'alice@example.test',
            name: 'Alice Motion',
            nonce: capturedNonce,
          });
          return new Response(JSON.stringify({ id_token: idToken, access_token: 'ext_at' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
      cache,
    );

    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache, oidc }));
    app.post('/mcp', createMcpBearerAuthMiddleware({ config, store, cache, oidc }), (c) => {
      const auth = getAuthContext(c);
      return c.json({ ok: true, userId: auth.userId, authMethod: auth.authMethod });
    });

    // Step 1: Start login -> redirects to IdP with S256 PKCE + state + nonce + HttpOnly tx cookie
    const loginRes = await app.request('/auth/login?returnTo=/projects');
    assert.equal(loginRes.status, 302);
    const location = new URL(loginRes.headers.get('location')!);
    assert.equal(location.origin, 'https://idp.example.test');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    const state = location.searchParams.get('state')!;
    capturedNonce = location.searchParams.get('nonce')!;
    const setCookies = loginRes.headers.getSetCookie();
    const txCookie = extractCookieValue(setCookies, 'om_oidc_tx');
    assert.ok(txCookie);

    // Step 2: Callback exchanges code + PKCE verifier, verifies id_token via JWKS, creates PG session
    const cbRes = await app.request(`/auth/callback?code=auth-code-123&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: `om_oidc_tx=${encodeURIComponent(txCookie)}` },
    });
    assert.equal(cbRes.status, 302);
    assert.equal(cbRes.headers.get('location'), '/projects');
    assert.ok(capturedCodeVerifier.length >= 43);

    const sessionCookies = cbRes.headers.getSetCookie();
    const rawSessionCookieHeader = sessionCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))!;
    assert.ok(rawSessionCookieHeader.includes('HttpOnly'));
    assert.ok(rawSessionCookieHeader.includes('SameSite=Lax'));
    assert.ok(rawSessionCookieHeader.includes('Secure'));
    const sessionToken = extractCookieValue(sessionCookies, SESSION_COOKIE_NAME)!;

    // Step 3: Authenticated /auth/me works via cookie
    const meRes = await app.request('/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    });
    assert.equal(meRes.status, 200);
    const me = (await meRes.json()) as {
      user: { email: string; displayName: string };
      authMethod: string;
    };
    assert.equal(me.authMethod, 'session_cookie');
    assert.equal(me.user.email, 'alice@example.test');
    assert.equal(me.user.displayName, 'Alice Motion');

    // Step 4: Browser cookie is STRICTLY REJECTED on /mcp with RFC 9728 WWW-Authenticate
    const mcpCookieRes = await app.request('/mcp', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    });
    assert.equal(mcpCookieRes.status, 401);
    assert.match(
      mcpCookieRes.headers.get('www-authenticate') ?? '',
      /resource_metadata="https:\/\/motion\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
    );

    // Step 5: Direct OIDC Bearer JWT verified via JWKS works on /mcp
    const directJwt = await signJwt({
      sub: 'opendesign-user-42',
      email: 'alice@example.test',
      name: 'Alice Motion',
    });
    const mcpJwtRes = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${directJwt}` },
    });
    assert.equal(mcpJwtRes.status, 200);
    assert.equal(((await mcpJwtRes.json()) as { authMethod: string }).authMethod, 'oidc_jwt');

    // Step 5b: Direct OIDC Bearer JWT validates X-OpenMotion-Workspace-Id strictly (400 invalid UUID, 403 non-member)
    const invalidWsRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${directJwt}`,
        'X-OpenMotion-Workspace-Id': 'not-a-uuid',
      },
    });
    assert.equal(invalidWsRes.status, 400);
    assert.equal(((await invalidWsRes.json()) as { code: string }).code, 'INVALID_ARGUMENT');

    const foreignWsRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${directJwt}`,
        'X-OpenMotion-Workspace-Id': randomUUID(),
      },
    });
    assert.equal(foreignWsRes.status, 403);
    assert.equal(((await foreignWsRes.json()) as { code: string }).code, 'WORKSPACE_FORBIDDEN');

    // Brand-new OIDC user specifying an unowned workspace UUID must also be rejected with 403 (never auto-provisioned into wrong workspace)
    const brandNewJwt = await signJwt({
      sub: 'opendesign-brand-new-99',
      email: 'bob@example.test',
      name: 'Bob New',
    });
    const brandNewForbidden = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${brandNewJwt}`,
        'X-OpenMotion-Workspace-Id': randomUUID(),
      },
    });
    assert.equal(brandNewForbidden.status, 403);
    assert.equal(((await brandNewForbidden.json()) as { code: string }).code, 'WORKSPACE_FORBIDDEN');
    assert.equal(await store.findUserByOidcSub('opendesign-brand-new-99'), null);

    // Step 6: CSRF Origin defense blocks cross-origin and null-origin cookie mutations
    const badOriginLogout = await app.request('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        Origin: 'https://evil.example.net',
      },
    });
    assert.equal(badOriginLogout.status, 403);

    const nullOriginPat = await app.request('/motion-api/tokens', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        Origin: 'null',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'csrf-attempt' }),
    });
    assert.equal(nullOriginPat.status, 403);

    // Step 7: Same-origin logout revokes session authoritatively and evicts Redis cache immediately
    const logoutRes = await app.request('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        Origin: 'https://motion.example.test',
      },
    });
    assert.equal(logoutRes.status, 200);
    const logoutBody = (await logoutRes.json()) as { ok: boolean; endSessionUrl?: string };
    assert.equal(logoutBody.ok, true);
    assert.equal(logoutBody.endSessionUrl, undefined);

    const afterLogoutMe = await app.request('/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    });
    assert.equal(afterLogoutMe.status, 401);
  });

  it('calls IdP end_session_endpoint server-side with id_token_hint on logout without exposing endSessionUrl to the browser (OPEND-5726)', async () => {
    const config = makeConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'logout-key-1';
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    let currentNonce = '';
    let issuedIdToken = '';
    const endSessionRequests: URL[] = [];
    let endSessionStatus = 200;

    const oidc = new OidcService(
      {
        issuer: 'https://idp.example.test',
        clientId: 'openmotion-web',
        clientSecret: 'super-secret-client',
        callbackUrl: 'https://motion.example.test/auth/callback',
        scopes: 'openid profile email',
        claimSub: 'sub',
        claimEmail: 'email',
        claimName: 'name',
        discovery: {
          issuer: 'https://idp.example.test',
          authorization_endpoint: 'https://idp.example.test/authorize',
          token_endpoint: 'https://idp.example.test/token',
          jwks_uri: 'https://idp.example.test/jwks',
          end_session_endpoint: 'https://idp.example.test/oauth2/end-session',
        },
        jwks: createLocalJWKSet({ keys: [jwk] }),
        fetcher: async (input) => {
          const url = new URL(String(input));
          if (url.pathname === '/token') {
            issuedIdToken = await new SignJWT({
              sub: 'opendesign-logout-user',
              email: 'logout@example.test',
              name: 'Logout User',
              nonce: currentNonce,
              sid: 'upstream-session-1',
            })
              .setProtectedHeader({ alg: 'RS256', kid: 'logout-key-1' })
              .setIssuer('https://idp.example.test')
              .setAudience('openmotion-web')
              .setIssuedAt()
              .setExpirationTime('10m')
              .sign(privateKey);
            return new Response(
              JSON.stringify({ id_token: issuedIdToken, access_token: 'opaque' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (url.pathname === '/oauth2/end-session') {
            endSessionRequests.push(url);
            return new Response(null, { status: endSessionStatus });
          }
          return new Response('not found', { status: 404 });
        },
      },
      cache,
    );

    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache, oidc }));

    async function loginAndGetSession() {
      const loginRes = await app.request('/auth/login?returnTo=/explore');
      const authUrl = new URL(loginRes.headers.get('location')!);
      currentNonce = authUrl.searchParams.get('nonce')!;
      const txCookie = extractCookieValue(loginRes.headers.getSetCookie(), 'om_oidc_tx')!;
      const cbRes = await app.request(
        `/auth/callback?code=code-1&state=${encodeURIComponent(authUrl.searchParams.get('state')!)}`,
        { headers: { Cookie: `om_oidc_tx=${encodeURIComponent(txCookie)}` } },
      );
      assert.equal(cbRes.status, 302);
      return extractCookieValue(cbRes.headers.getSetCookie(), SESSION_COOKIE_NAME)!;
    }

    // 1. Normal logout revokes local session AND calls IdP end-session server-side with id_token_hint.
    const session1 = await loginAndGetSession();
    const idToken1 = issuedIdToken;
    const logout1 = await app.request('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${session1}`,
        Origin: 'https://motion.example.test',
      },
    });
    assert.equal(logout1.status, 200);
    const body1 = (await logout1.json()) as { ok: boolean; endSessionUrl?: string };
    assert.equal(body1.ok, true);
    assert.equal(body1.endSessionUrl, undefined);
    assert.equal(endSessionRequests.length, 1);
    assert.equal(endSessionRequests[0]!.searchParams.get('id_token_hint'), idToken1);
    assert.equal(endSessionRequests[0]!.searchParams.get('client_id'), 'openmotion-web');

    // 2. Upstream end-session failure does NOT fail local logout or return a broken browser redirect.
    endSessionStatus = 500;
    const session2 = await loginAndGetSession();
    const logout2 = await app.request('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${session2}`,
        Origin: 'https://motion.example.test',
      },
    });
    assert.equal(logout2.status, 200);
    assert.deepEqual(await logout2.json(), { ok: true });
    assert.equal(endSessionRequests.length, 2);
    const afterLogout2 = await app.request('/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session2}` },
    });
    assert.equal(afterLogout2.status, 401);
  });
});

describe('PAT Lifecycle & Strict Scope Non-Escalation', () => {
  it('hashes PAT with SHA-256, uses #11 default scopes, and NEVER elevates a restricted owner PAT', async () => {
    const config = makeConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();
    const seeded = store.seedWorkspace({ role: 'owner', displayName: 'Owner Alice' });

    const ownerBrowserAuth = {
      workspaceId: seeded.workspace.id,
      userId: seeded.user.id,
      role: 'owner' as const,
      scopes: [...PAT_SCOPES],
      authMode: 'oidc' as const,
      authMethod: 'session_cookie' as const,
    };

    // Default PAT gets exact #11 default scopes (excluding workspace:admin)
    const defaultPat = await createPat(store, ownerBrowserAuth, { name: 'CI Default' });
    assert.match(defaultPat.token, /^om_pat_[a-f0-9]{8}_[A-Za-z0-9_-]+$/);
    assert.deepEqual(defaultPat.scopes, [...DEFAULT_PAT_SCOPES]);
    assert.equal(defaultPat.scopes.includes('workspace:admin'), false);

    // Raw secret is NEVER persisted — only SHA-256 hash
    const storedRow = store.pats.get(defaultPat.id)!;
    assert.equal(storedRow.tokenHash, sha256Hex(defaultPat.token));
    assert.notEqual(storedRow.tokenHash, defaultPat.token);

    // Restricted PAT owned by an `owner` with ONLY `projects:read` MUST NOT escalate
    const restrictedPat = await createPat(store, ownerBrowserAuth, {
      name: 'Read Only Audit',
      scopes: ['projects:read'],
    });
    const verifiedRestricted = await verifyPat(store, restrictedPat.token, {
      authMode: 'oidc',
      cache,
    });
    assert.ok(verifiedRestricted);
    assert.equal(verifiedRestricted.role, 'owner');
    assert.equal(hasScope(verifiedRestricted, 'projects:read'), true);
    assert.equal(hasScope(verifiedRestricted, 'projects:write'), false);
    assert.equal(hasScope(verifiedRestricted, 'workspace:admin'), false);

    // Verify Hono middleware rejects restricted PAT on protected route
    const app = new Hono<AuthEnv>();
    app.use('/protected/*', createAuthMiddleware({ config, store, cache }));
    app.post('/protected/admin', requireScope('workspace:admin'), (c) => c.json({ ok: true }));
    app.get('/protected/read', requireScope('projects:read'), (c) => c.json({ ok: true }));

    const readOk = await app.request('/protected/read', {
      headers: { Authorization: `Bearer ${restrictedPat.token}` },
    });
    assert.equal(readOk.status, 200);

    const adminBlocked = await app.request('/protected/admin', {
      method: 'POST',
      headers: { Authorization: `Bearer ${restrictedPat.token}` },
    });
    assert.equal(adminBlocked.status, 403);
    assert.equal(((await adminBlocked.json()) as { code: string }).code, 'INSUFFICIENT_SCOPE');

    // Live demotion to viewer immediately strips write scopes from an existing default PAT
    store.setRole(seeded.workspace.id, seeded.user.id, 'viewer');
    const afterDemotion = await verifyPat(store, defaultPat.token, { authMode: 'oidc', cache });
    assert.ok(afterDemotion);
    assert.equal(hasScope(afterDemotion, 'projects:read'), true);
    assert.equal(hasScope(afterDemotion, 'projects:write'), false);
    assert.equal(hasScope(afterDemotion, 'exports:write'), false);
  });
});

describe('OAuth 2.1 Proxy & Delegated Modes (RFC 9728, RFC 8414, DCR, PKCE S256, Rotation, Revoke)', () => {
  it('completes full DCR -> PKCE authorize -> token exchange -> refresh rotation -> revocation flow', async () => {
    const config = makeConfig({ MCP_OAUTH_MODE: 'proxy' });
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();
    const seeded = store.seedWorkspace({ role: 'editor', displayName: 'Editor Bob' });
    const session = await createBrowserSession(store, {
      userId: seeded.user.id,
      workspaceId: seeded.workspace.id,
    });

    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache }));
    app.post('/mcp', createMcpBearerAuthMiddleware({ config, store, cache }), (c) => {
      const auth = getAuthContext(c);
      return c.json({
        workspaceId: auth.workspaceId,
        scopes: auth.scopes,
        authMethod: auth.authMethod,
      });
    });

    // RFC 9728 Protected Resource Metadata
    const prmRes = await app.request('/.well-known/oauth-protected-resource/mcp');
    assert.equal(prmRes.status, 200);
    const prm = (await prmRes.json()) as { resource: string; authorization_servers: string[] };
    assert.equal(prm.resource, 'https://motion.example.test/mcp');
    assert.deepEqual(prm.authorization_servers, ['https://motion.example.test']);

    // RFC 8414 Authorization Server Metadata
    const asmRes = await app.request('/.well-known/oauth-authorization-server');
    assert.equal(asmRes.status, 200);
    const asm = (await asmRes.json()) as {
      code_challenge_methods_supported: string[];
      registration_endpoint: string;
    };
    assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
    assert.equal(asm.registration_endpoint, 'https://motion.example.test/oauth/register');

    // RFC 7591 DCR rejects non-HTTPS non-loopback redirect URI
    const badDcr = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Unsafe Client',
        redirect_uris: ['http://evil.example.com/callback'],
      }),
    });
    assert.equal(badDcr.status, 400);

    // Valid DCR registration
    const dcrRes = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT Cloud',
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(dcrRes.status, 201);
    const client = (await dcrRes.json()) as { client_id: string };
    assert.ok(client.client_id.startsWith('om_client_'));

    // PKCE S256 Authorization GET -> Consent HTML -> POST approve
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const authQuery = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: 'mcp:tools projects:read',
      state: 'st-xyz',
      resource: 'https://motion.example.test/mcp',
    });

    const consentRes = await app.request(`/oauth/authorize?${authQuery.toString()}`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
    });
    assert.equal(consentRes.status, 200);
    const consentHtml = await consentRes.text();
    const consentTokenMatch = /name="consent_token" value="([^"]+)"/.exec(consentHtml);
    assert.ok(consentTokenMatch);

    // Omitting consent_token when cache is active MUST be rejected (prevents CSRF bypass)
    const missingConsentBody = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: 'mcp:tools projects:read',
      state: 'st-xyz',
      resource: 'https://motion.example.test/mcp',
      decision: 'approve',
    });
    const missingConsentRes = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${session.token}`,
        Origin: 'https://motion.example.test',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: missingConsentBody.toString(),
    });
    assert.equal(missingConsentRes.status, 400);

    const approveBody = new URLSearchParams({
      consent_token: consentTokenMatch[1],
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: 'mcp:tools projects:read',
      state: 'st-xyz',
      resource: 'https://motion.example.test/mcp',
      decision: 'approve',
    });

    const approveRes = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${session.token}`,
        Origin: 'https://motion.example.test',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: approveBody.toString(),
    });
    assert.equal(approveRes.status, 302);
    const redirectUrl = new URL(approveRes.headers.get('location')!);
    const authCode = redirectUrl.searchParams.get('code')!;
    assert.equal(redirectUrl.searchParams.get('state'), 'st-xyz');
    assert.ok(authCode.length > 20);

    // Replaying the same single-use consent_token MUST fail with 400
    const replayConsentRes = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${session.token}`,
        Origin: 'https://motion.example.test',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: approveBody.toString(),
    });
    assert.equal(replayConsentRes.status, 400);

    // Wrong PKCE verifier fails (and single-use code is consumed!)
    // First test fresh code with valid verifier:
    const tokenRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        client_id: client.client_id,
        code_verifier: codeVerifier,
      }).toString(),
    });
    assert.equal(tokenRes.status, 200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    assert.equal(tokens.scope, 'mcp:tools projects:read');

    // Replaying the same authorization code fails
    const replayRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        client_id: client.client_id,
        code_verifier: codeVerifier,
      }).toString(),
    });
    assert.equal(replayRes.status, 400);

    // Access token authenticates /mcp with exact granted scopes
    const mcpOk = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    assert.equal(mcpOk.status, 200);
    const mcpData = (await mcpOk.json()) as {
      authMethod: string;
      scopes: string[];
      workspaceId: string;
    };
    assert.equal(mcpData.authMethod, 'oauth_bearer');
    assert.equal(mcpData.workspaceId, seeded.workspace.id);
    assert.deepEqual(mcpData.scopes, ['mcp:tools', 'projects:read']);

    // Concurrent refresh token rotation race: even when both callers read the same active row
    // simultaneously before revocation, strictly ONE succeeds and the other fails with 400.
    const origFindByRefresh = store.findActiveOAuthTokenByRefreshHash.bind(store);
    let releaseBarrier!: () => void;
    let arrived = 0;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    store.findActiveOAuthTokenByRefreshHash = async (hash) => {
      const found = await origFindByRefresh(hash);
      arrived += 1;
      if (arrived === 2) releaseBarrier();
      await barrier;
      return found;
    };

    const [raceA, raceB] = await Promise.all([
      app.request('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: client.client_id,
        }).toString(),
      }),
      app.request('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: client.client_id,
        }).toString(),
      }),
    ]);
    store.findActiveOAuthTokenByRefreshHash = origFindByRefresh;

    const statuses = [raceA.status, raceB.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 400]);
    const winnerRes = raceA.status === 200 ? raceA : raceB;
    const rotated = (await winnerRes.json()) as { access_token: string; refresh_token: string };
    assert.notEqual(rotated.access_token, tokens.access_token);

    const oldRefreshReplay = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }).toString(),
    });
    assert.equal(oldRefreshReplay.status, 400);

    // RFC 7009 revocation immediately invalidates rotated access token on /mcp
    const revokeRes = await app.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: rotated.access_token }).toString(),
    });
    assert.equal(revokeRes.status, 200);

    const mcpAfterRevoke = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rotated.access_token}` },
    });
    assert.equal(mcpAfterRevoke.status, 401);
  });

  it('revokes every live token of the connection when a rotated refresh token is replayed after the grace window', async () => {
    const config = makeConfig();
    const oauthCfg = buildOAuth21Config(config);
    const store = new InMemoryAuthStore();
    const seeded = store.seedWorkspace({
      email: 'reuse@example.test',
      displayName: 'Reuse',
    });
    const client = await registerOAuthClient(store, {
      client_name: 'Reuse probe',
      redirect_uris: ['http://127.0.0.1:53682/callback'],
    });
    const seedRefresh = async (fill: string) => {
      const refreshToken = `om_ort_${fill.repeat(48)}`;
      await store.createOAuthToken({
        clientId: client.client_id,
        userId: seeded.user.id,
        workspaceId: seeded.workspace.id,
        accessTokenHash: sha256Hex(`om_oat_${fill.repeat(48)}`),
        refreshTokenHash: sha256Hex(refreshToken),
        scope: 'projects:read mcp:tools',
        resource: null,
        accessExpiresAt: new Date(Date.now() + 3600_000),
        refreshExpiresAt: new Date(Date.now() + 86_400_000),
      });
      return refreshToken;
    };
    const refresh = (refreshToken: string) =>
      exchangeOAuthToken(store, oauthCfg, { grantType: 'refresh_token', refreshToken, clientId: client.client_id });
    const isLive = async (accessToken: string) =>
      (await store.findActiveOAuthTokenByAccessHash(sha256Hex(accessToken))) !== null;

    // Explicit revocation (RFC 7009 / disconnect) is not rotation: replaying that token revokes nothing else.
    const explicitlyRevoked = await seedRefresh('e');
    const other = await refresh(await seedRefresh('o'));
    await revokeOAuthToken(store, explicitlyRevoked);
    const explicitRow = [...store.oauthTokens.values()].find(t => t.accessTokenHash === sha256Hex(`om_oat_${'e'.repeat(48)}`));
    explicitRow!.revokedAt = new Date(Date.now() - 31_000);
    await assert.rejects(refresh(explicitlyRevoked), /invalid_grant/);
    assert.equal(await isLive(other.access_token), true);

    const original = await seedRefresh('r');
    const rotated = await refresh(original);
    // A replay inside the grace window (e.g. a concurrent refresh) only fails; the winner stays valid.
    await assert.rejects(refresh(original), /invalid_grant/);
    assert.equal(await isLive(rotated.access_token), true);

    // Outside the window the replay is treated as theft and the connection's live tokens are revoked.
    const originalRow = await store.findOAuthTokenByRefreshHash(sha256Hex(original));
    originalRow!.revokedAt = new Date(Date.now() - 31_000);
    await assert.rejects(refresh(original), /invalid_grant/);
    assert.equal(await isLive(rotated.access_token), false);
    assert.equal(await isLive(other.access_token), false);
    await assert.rejects(refresh(rotated.refresh_token), /invalid_grant/);
  });

  it('advertises external issuer in MCP_OAUTH_MODE=delegated and disables proxy DCR endpoints', async () => {
    const config = makeConfig({
      MCP_OAUTH_MODE: 'delegated',
      OIDC_ISSUER: 'https://auth.open-design.ai',
    });
    const store = new InMemoryAuthStore();
    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store }));

    const prmRes = await app.request('/.well-known/oauth-protected-resource/mcp');
    assert.equal(prmRes.status, 200);
    const prm = (await prmRes.json()) as { authorization_servers: string[] };
    assert.deepEqual(prm.authorization_servers, ['https://auth.open-design.ai']);

    const asmRes = await app.request('/.well-known/oauth-authorization-server');
    assert.equal(asmRes.status, 404);
  });
});

describe('AUTH_MODE=oidc HS256 ID Token Interop (OpenDesign / Vela Better Auth) & Security Guards', () => {
  const VELA_ISSUER = 'https://amr-api.open-design.ai/api/auth';
  const VELA_CLIENT_ID = 'openmotion-first-party';
  const VELA_CLIENT_SECRET = 'vela-hs256-client-secret-minimum-32-chars';

  async function signHs256Jwt(
    claims: Record<string, unknown>,
    options: { secret?: string; issuer?: string; audience?: string } = {},
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setIssuer(options.issuer ?? VELA_ISSUER)
      .setAudience(options.audience ?? VELA_CLIENT_ID)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(options.secret ?? VELA_CLIENT_SECRET));
  }

  function makeVelaConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
    return makeConfig({
      OIDC_ISSUER: VELA_ISSUER,
      OIDC_CLIENT_ID: VELA_CLIENT_ID,
      OIDC_CLIENT_SECRET: VELA_CLIENT_SECRET,
      ...overrides,
    });
  }

  it('completes OIDC Auth Code + PKCE using dynamic discovery without jwks_uri and verifies HS256 id_token with RFC 9207 iss', async () => {
    const config = makeVelaConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();

    let discoveredUrl = '';
    let capturedNonce = '';
    let capturedTokenParams: URLSearchParams | null = null;

    const oidc = new OidcService(
      {
        issuer: VELA_ISSUER,
        clientId: VELA_CLIENT_ID,
        clientSecret: VELA_CLIENT_SECRET,
        callbackUrl: 'https://motion.example.test/auth/callback',
        scopes: 'openid profile email',
        claimSub: 'sub',
        claimEmail: 'email',
        claimName: 'name',
        fetcher: async (url, init) => {
          const target = String(url);
          if (target.endsWith('/.well-known/openid-configuration')) {
            discoveredUrl = target;
            return new Response(
              JSON.stringify({
                issuer: VELA_ISSUER,
                authorization_endpoint: `${VELA_ISSUER}/oauth2/authorize`,
                token_endpoint: `${VELA_ISSUER}/oauth2/token`,
                userinfo_endpoint: `${VELA_ISSUER}/oauth2/userinfo`,
                end_session_endpoint: `${VELA_ISSUER}/oauth2/end-session`,
                id_token_signing_alg_values_supported: ['HS256'],
                authorization_response_iss_parameter_supported: true,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (target === `${VELA_ISSUER}/oauth2/token`) {
            capturedTokenParams = new URLSearchParams(String(init?.body ?? ''));
            const idToken = await signHs256Jwt({
              sub: 'vela_user_001',
              email: 'vela.alice@example.test',
              name: 'Alice Vela',
              picture: 'https://cdn.open-design.test/avatar.png',
              sid: 'vela_session_001',
              nonce: capturedNonce,
            });
            return new Response(
              JSON.stringify({ id_token: idToken, access_token: 'opaque_vela_at', token_type: 'Bearer' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      },
      cache,
    );

    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache, oidc }));

    const loginRes = await app.request('/auth/login?returnTo=/create');
    assert.equal(loginRes.status, 302);
    assert.equal(discoveredUrl, `${VELA_ISSUER}/.well-known/openid-configuration`);
    const authorizeUrl = new URL(loginRes.headers.get('location')!);
    assert.equal(authorizeUrl.origin + authorizeUrl.pathname, `${VELA_ISSUER}/oauth2/authorize`);
    const state = authorizeUrl.searchParams.get('state')!;
    capturedNonce = authorizeUrl.searchParams.get('nonce')!;
    const txCookie = extractCookieValue(loginRes.headers.getSetCookie(), 'om_oidc_tx')!;

    const cbRes = await app.request(
      `/auth/callback?code=vela-code-1&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(VELA_ISSUER)}`,
      { headers: { Cookie: `om_oidc_tx=${encodeURIComponent(txCookie)}` } },
    );
    assert.equal(cbRes.status, 302);
    assert.equal(cbRes.headers.get('location'), '/create');
    assert.equal(capturedTokenParams!.get('client_id'), VELA_CLIENT_ID);
    assert.equal(capturedTokenParams!.get('client_secret'), VELA_CLIENT_SECRET);
    assert.equal(capturedTokenParams!.get('redirect_uri'), 'https://motion.example.test/auth/callback');
    assert.ok((capturedTokenParams!.get('code_verifier') ?? '').length >= 43);

    const sessionToken = extractCookieValue(cbRes.headers.getSetCookie(), SESSION_COOKIE_NAME)!;
    const meRes = await app.request('/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    });
    assert.equal(meRes.status, 200);
    const me = (await meRes.json()) as {
      authenticated: boolean;
      user: { email: string; displayName: string };
    };
    assert.equal(me.authenticated, true);
    assert.equal(me.user.email, 'vela.alice@example.test');
    assert.equal(me.user.displayName, 'Alice Vela');
  });

  it('rejects wrong HS256 secret, algorithm confusion against RS256 JWKS IdP, RFC 9207 iss mismatch, OAuth error, and missing jwks_uri/secret discovery', async () => {
    const config = makeVelaConfig();

    // 1. Wrong HS256 secret -> 401
    {
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();
      let nonce = '';
      const oidc = new OidcService(
        {
          issuer: VELA_ISSUER,
          clientId: VELA_CLIENT_ID,
          clientSecret: VELA_CLIENT_SECRET,
          callbackUrl: 'https://motion.example.test/auth/callback',
          scopes: 'openid profile email',
          claimSub: 'sub',
          claimEmail: 'email',
          claimName: 'name',
          discovery: {
            issuer: VELA_ISSUER,
            authorization_endpoint: `${VELA_ISSUER}/oauth2/authorize`,
            token_endpoint: `${VELA_ISSUER}/oauth2/token`,
            id_token_signing_alg_values_supported: ['HS256'],
          },
          fetcher: async () =>
            new Response(
              JSON.stringify({
                id_token: await signHs256Jwt(
                  { sub: 'u1', email: 'u1@example.test', nonce },
                  { secret: 'wrong-client-secret-not-matching-configured' },
                ),
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        },
        cache,
      );
      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store, cache, oidc }));
      const loginRes = await app.request('/auth/login');
      const authUrl = new URL(loginRes.headers.get('location')!);
      nonce = authUrl.searchParams.get('nonce')!;
      const txCookie = extractCookieValue(loginRes.headers.getSetCookie(), 'om_oidc_tx')!;
      const cbRes = await app.request(
        `/auth/callback?code=c1&state=${encodeURIComponent(authUrl.searchParams.get('state')!)}`,
        { headers: { Cookie: `om_oidc_tx=${encodeURIComponent(txCookie)}` } },
      );
      assert.equal(cbRes.status, 401);
    }

    // 2. Asymmetric RS256+JWKS IdP receiving HS256 token signed with clientSecret -> 401 (anti alg-confusion)
    {
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();
      const { jwks } = await createEphemeralOidcFixture();
      let nonce = '';
      const oidc = new OidcService(
        {
          issuer: 'https://idp.example.test',
          clientId: 'openmotion-cloud-client',
          clientSecret: 'ephemeral-test-client-secret',
          callbackUrl: 'https://motion.example.test/auth/callback',
          scopes: 'openid profile email',
          claimSub: 'sub',
          claimEmail: 'email',
          claimName: 'name',
          discovery: {
            issuer: 'https://idp.example.test',
            authorization_endpoint: 'https://idp.example.test/authorize',
            token_endpoint: 'https://idp.example.test/token',
            jwks_uri: 'https://idp.example.test/jwks.json',
            id_token_signing_alg_values_supported: ['RS256'],
          },
          jwks,
          fetcher: async () =>
            new Response(
              JSON.stringify({
                id_token: await signHs256Jwt(
                  { sub: 'attacker', email: 'attacker@example.test', nonce },
                  {
                    secret: 'ephemeral-test-client-secret',
                    issuer: 'https://idp.example.test',
                    audience: 'openmotion-cloud-client',
                  },
                ),
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        },
        cache,
      );
      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config: makeConfig(), store, cache, oidc }));
      const loginRes = await app.request('/auth/login');
      const authUrl = new URL(loginRes.headers.get('location')!);
      nonce = authUrl.searchParams.get('nonce')!;
      const txCookie = extractCookieValue(loginRes.headers.getSetCookie(), 'om_oidc_tx')!;
      const cbRes = await app.request(
        `/auth/callback?code=c2&state=${encodeURIComponent(authUrl.searchParams.get('state')!)}`,
        { headers: { Cookie: `om_oidc_tx=${encodeURIComponent(txCookie)}` } },
      );
      assert.equal(cbRes.status, 401);
    }

    // 3. RFC 9207 iss mismatch AND OAuth error param (consumes tx state on error)
    {
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();
      let tokenCalls = 0;
      const oidc = new OidcService(
        {
          issuer: VELA_ISSUER,
          clientId: VELA_CLIENT_ID,
          clientSecret: VELA_CLIENT_SECRET,
          callbackUrl: 'https://motion.example.test/auth/callback',
          scopes: 'openid profile email',
          claimSub: 'sub',
          claimEmail: 'email',
          claimName: 'name',
          discovery: {
            issuer: VELA_ISSUER,
            authorization_endpoint: `${VELA_ISSUER}/oauth2/authorize`,
            token_endpoint: `${VELA_ISSUER}/oauth2/token`,
            id_token_signing_alg_values_supported: ['HS256'],
          },
          fetcher: async () => {
            tokenCalls += 1;
            return new Response('should not be called', { status: 500 });
          },
        },
        cache,
      );
      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store, cache, oidc }));

      const login1 = await app.request('/auth/login');
      const state1 = new URL(login1.headers.get('location')!).searchParams.get('state')!;
      const tx1 = extractCookieValue(login1.headers.getSetCookie(), 'om_oidc_tx')!;
      const mismatchIss = await app.request(
        `/auth/callback?code=c3&state=${encodeURIComponent(state1)}&iss=${encodeURIComponent('https://evil.example.net/api/auth')}`,
        { headers: { Cookie: `om_oidc_tx=${encodeURIComponent(tx1)}` } },
      );
      assert.equal(mismatchIss.status, 401);
      assert.equal(tokenCalls, 0);

      const login2 = await app.request('/auth/login?returnTo=%2Fcreate%2Fimage%3Ftab%3Ddraft&hook_id=header_signin&entry_id=entry-1');
      const state2 = new URL(login2.headers.get('location')!).searchParams.get('state')!;
      const tx2 = extractCookieValue(login2.headers.getSetCookie(), 'om_oidc_tx')!;
      const attr2 = extractCookieValue(login2.headers.getSetCookie(), 'om_auth_attr')!;
      const errorCb = await app.request(
        `/auth/callback?error=login_required&state=${encodeURIComponent(state2)}`,
        { headers: { Cookie: `om_oidc_tx=${encodeURIComponent(tx2)}; om_auth_attr=${encodeURIComponent(attr2)}` } },
      );
      // User cancellation (login_required / access_denied) with verified state + tx cookie
      // redirects back to the originating page instead of exposing raw 401 JSON,
      // clears om_oidc_tx and om_auth_attr, never sets a session cookie, and consumes the single-use transaction.
      assert.equal(errorCb.status, 302);
      assert.equal(errorCb.headers.get('location'), '/create/image?tab=draft&auth_cancelled=1');
      const cancelSetCookies = errorCb.headers.getSetCookie();
      assert.ok(cancelSetCookies.some((c) => c.startsWith('om_oidc_tx=;')));
      assert.ok(cancelSetCookies.some((c) => c.startsWith('om_auth_attr=;')));
      assert.ok(!cancelSetCookies.some((c) => c.startsWith('om_session=') && !c.startsWith('om_session=;')));
      // Consumed transaction cannot be replayed with a code
      const replayAfterError = await app.request(
        `/auth/callback?code=c4&state=${encodeURIComponent(state2)}`,
        { headers: { Cookie: `om_oidc_tx=${encodeURIComponent(tx2)}` } },
      );
      assert.equal(replayAfterError.status, 401);
      // Reloading or revisiting a consumed cancellation callback falls back safely to /?auth_cancelled=1
      const replayCancelAfterError = await app.request(
        `/auth/callback?error=login_required&state=${encodeURIComponent(state2)}`,
        { headers: { Cookie: `om_oidc_tx=${encodeURIComponent(tx2)}` } },
      );
      assert.equal(replayCancelAfterError.status, 302);
      assert.equal(replayCancelAfterError.headers.get('location'), '/?auth_cancelled=1');
      assert.equal(replayCancelAfterError.headers.getSetCookie().length, 0);
      // Fatal non-cancel OIDC errors and mismatched issuer on cancel still return 401.
      const login3 = await app.request('/auth/login?returnTo=%2Fexplore');
      const state3 = new URL(login3.headers.get('location')!).searchParams.get('state')!;
      const tx3 = extractCookieValue(login3.headers.getSetCookie(), 'om_oidc_tx')!;
      const serverErrCb = await app.request(
        `/auth/callback?error=server_error&state=${encodeURIComponent(state3)}`,
        { headers: { Cookie: `om_oidc_tx=${encodeURIComponent(tx3)}` } },
      );
      assert.equal(serverErrCb.status, 401);
      const login3b = await app.request('/auth/login?returnTo=%2Fexplore');
      const state3b = new URL(login3b.headers.get('location')!).searchParams.get('state')!;
      const tx3b = extractCookieValue(login3b.headers.getSetCookie(), 'om_oidc_tx')!;
      const mismatchIssCancel = await app.request(
        `/auth/callback?error=login_required&state=${encodeURIComponent(state3b)}&iss=${encodeURIComponent('https://evil.example.net/api/auth')}`,
        { headers: { Cookie: `om_oidc_tx=${encodeURIComponent(tx3b)}` } },
      );
      assert.equal(mismatchIssCancel.status, 401);
      // Known cancellation error with missing or cross-tab-overwritten tx cookie falls back safely
      // to /?auth_cancelled=1 without honoring unverified returnTo, setting a session, or clearing another tab's cookie.
      const login4 = await app.request('/auth/login?returnTo=%2Fexplore');
      const state4 = new URL(login4.headers.get('location')!).searchParams.get('state')!;
      const missingTxCb = await app.request(
        `/auth/callback?error=login_required&state=${encodeURIComponent(state4)}`,
      );
      assert.equal(missingTxCb.status, 302);
      assert.equal(missingTxCb.headers.get('location'), '/?auth_cancelled=1');
      assert.equal(missingTxCb.headers.getSetCookie().length, 0);
      // State4 was still consumed so it cannot be replayed with a code
      const replayState4 = await app.request(
        `/auth/callback?code=c5&state=${encodeURIComponent(state4)}`,
      );
      assert.equal(replayState4.status, 401);
      // Cross-tab scenario: Tab 2 starts a newer login overwriting om_oidc_tx; cancelling Tab 1
      // falls back to /?auth_cancelled=1 without clearing Tab 2's om_oidc_tx cookie.
      const tab1Login = await app.request('/auth/login?returnTo=%2Fcreate%2Fimage');
      const tab1State = new URL(tab1Login.headers.get('location')!).searchParams.get('state')!;
      const tab2Login = await app.request('/auth/login?returnTo=%2Fassets');
      const tab2Tx = extractCookieValue(tab2Login.headers.getSetCookie(), 'om_oidc_tx')!;
      const tab1Cancel = await app.request(
        `/auth/callback?error=login_required&state=${encodeURIComponent(tab1State)}`,
        { headers: { Cookie: `om_oidc_tx=${encodeURIComponent(tab2Tx)}` } },
      );
      assert.equal(tab1Cancel.status, 302);
      assert.equal(tab1Cancel.headers.get('location'), '/?auth_cancelled=1');
      assert.equal(tab1Cancel.headers.getSetCookie().length, 0);
      assert.equal(tokenCalls, 0);
    }

    // 4. Discovery omitting both jwks_uri and clientSecret fails with 502 SERVICE_UNAVAILABLE
    {
      const cache = new InMemoryAuthCache();
      const oidcNoSecret = new OidcService(
        {
          issuer: VELA_ISSUER,
          clientId: VELA_CLIENT_ID,
          callbackUrl: 'https://motion.example.test/auth/callback',
          scopes: 'openid profile email',
          claimSub: 'sub',
          claimEmail: 'email',
          claimName: 'name',
          fetcher: async () =>
            new Response(
              JSON.stringify({
                issuer: VELA_ISSUER,
                authorization_endpoint: `${VELA_ISSUER}/oauth2/authorize`,
                token_endpoint: `${VELA_ISSUER}/oauth2/token`,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        },
        cache,
      );
      await assert.rejects(
        () => oidcNoSecret.discover(),
        (err: unknown) =>
          Boolean(err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 502),
      );
    }
  });

  it('rejects HS256 JWTs on /mcp and /auth/me when IdP omits jwks_uri and isolates multi-tenant workspaces across HS256 OIDC users', async () => {
    const config = makeVelaConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();

    let activeSub = 'vela_alice';
    let activeEmail = 'alice.vela@example.test';
    let activeName = 'Alice Vela';
    let currentNonce = '';

    const oidc = new OidcService(
      {
        issuer: VELA_ISSUER,
        clientId: VELA_CLIENT_ID,
        clientSecret: VELA_CLIENT_SECRET,
        callbackUrl: 'https://motion.example.test/auth/callback',
        scopes: 'openid profile email',
        claimSub: 'sub',
        claimEmail: 'email',
        claimName: 'name',
        discovery: {
          issuer: VELA_ISSUER,
          authorization_endpoint: `${VELA_ISSUER}/oauth2/authorize`,
          token_endpoint: `${VELA_ISSUER}/oauth2/token`,
          id_token_signing_alg_values_supported: ['HS256'],
        },
        fetcher: async () =>
          new Response(
            JSON.stringify({
              id_token: await signHs256Jwt({
                sub: activeSub,
                email: activeEmail,
                name: activeName,
                nonce: currentNonce,
              }),
              access_token: 'opaque_at',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      },
      cache,
    );

    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache, oidc }));
    app.post('/mcp', createMcpBearerAuthMiddleware({ config, store, cache, oidc }), (c) => {
      return c.json({ ok: true, workspaceId: getAuthContext(c).workspaceId });
    });

    // Even a validly-signed HS256 JWT (with clientSecret!) is NEVER accepted as a Bearer token on /mcp or /auth/me
    const hs256Bearer = await signHs256Jwt({
      sub: 'vela_alice',
      email: 'alice.vela@example.test',
      name: 'Alice Vela',
    });
    const mcpBearerRes = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${hs256Bearer}` },
    });
    assert.equal(mcpBearerRes.status, 401);

    const meBearerRes = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${hs256Bearer}` },
    });
    assert.equal(meBearerRes.status, 401);

    // Multi-tenant isolation across two HS256 OIDC users (Alice & Bob)
    async function signInUser(sub: string, email: string, name: string) {
      activeSub = sub;
      activeEmail = email;
      activeName = name;
      const loginRes = await app.request('/auth/login');
      const authUrl = new URL(loginRes.headers.get('location')!);
      currentNonce = authUrl.searchParams.get('nonce')!;
      const txCookie = extractCookieValue(loginRes.headers.getSetCookie(), 'om_oidc_tx')!;
      const cbRes = await app.request(
        `/auth/callback?code=code-${sub}&state=${encodeURIComponent(authUrl.searchParams.get('state')!)}&iss=${encodeURIComponent(VELA_ISSUER)}`,
        { headers: { Cookie: `om_oidc_tx=${encodeURIComponent(txCookie)}` } },
      );
      assert.equal(cbRes.status, 302);
      const sessionCookie = extractCookieValue(cbRes.headers.getSetCookie(), SESSION_COOKIE_NAME)!;
      const meRes = await app.request('/auth/me', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      });
      assert.equal(meRes.status, 200);
      const me = (await meRes.json()) as { activeWorkspaceId: string; user: { id: string } };
      return { sessionCookie, workspaceId: me.activeWorkspaceId, userId: me.user.id };
    }

    const alice = await signInUser('vela_alice', 'alice.vela@example.test', 'Alice Vela');
    const bob = await signInUser('vela_bob', 'bob.vela@example.test', 'Bob Vela');
    assert.notEqual(alice.userId, bob.userId);
    assert.notEqual(alice.workspaceId, bob.workspaceId);

    // Cross-workspace access attempt via X-OpenMotion-Workspace-Id is rejected with 403 WORKSPACE_FORBIDDEN
    const crossTenant = await app.request('/auth/me', {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${bob.sessionCookie}`,
        'X-OpenMotion-Workspace-Id': alice.workspaceId,
      },
    });
    assert.equal(crossTenant.status, 403);
    assert.equal(((await crossTenant.json()) as { code: string }).code, 'WORKSPACE_FORBIDDEN');
  });

  it('persists device_id in om_auth_attr cookie on /auth/login and forwards it into trackWebSignInResult on callback success and cancel', async () => {
    const config = makeConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();
    const { jwks, signJwt } = await createEphemeralOidcFixture();

    let capturedNonce = '';
    const oidc = new OidcService(
      {
        issuer: 'https://idp.example.test',
        clientId: 'openmotion-cloud-client',
        clientSecret: 'ephemeral-test-client-secret',
        callbackUrl: 'https://motion.example.test/auth/callback',
        scopes: 'openid profile email',
        claimSub: 'sub',
        claimEmail: 'email',
        claimName: 'name',
        discovery: {
          issuer: 'https://idp.example.test',
          authorization_endpoint: 'https://idp.example.test/authorize',
          token_endpoint: 'https://idp.example.test/token',
          jwks_uri: 'https://idp.example.test/jwks.json',
        },
        jwks,
        fetcher: async () => {
          const idToken = await signJwt({
            sub: 'opendesign-device-user',
            email: 'dev@example.test',
            name: 'Dev User',
            nonce: capturedNonce,
          });
          return new Response(JSON.stringify({ id_token: idToken, access_token: 'ext_at' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
      cache,
    );

    const signInCalls: Array<Record<string, unknown>> = [];
    const cloudTracking = {
      trackWebSignInResult(params: Record<string, unknown>) {
        signInCalls.push(params);
      },
    } as unknown as Parameters<typeof createAuthRoutes>[0]['cloudTracking'];

    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache, oidc, cloudTracking }));

    // 1. Device-only login (no hook_id/entry_id) -> cookie carries deviceId -> callback success emits it
    const browserDeviceId = '11111111-2222-4333-8444-555555555555';
    const loginRes = await app.request(`/auth/login?returnTo=/studio&device_id=${encodeURIComponent(browserDeviceId)}`);
    assert.equal(loginRes.status, 302);
    const authUrl = new URL(loginRes.headers.get('location')!);
    capturedNonce = authUrl.searchParams.get('nonce')!;
    const loginCookies = loginRes.headers.getSetCookie();
    const txCookie = extractCookieValue(loginCookies, 'om_oidc_tx');
    const attrCookieRaw = extractCookieValue(loginCookies, 'om_auth_attr');
    assert.ok(txCookie);
    assert.ok(attrCookieRaw);
    const parsedAttr = JSON.parse(decodeURIComponent(attrCookieRaw)) as { deviceId?: string };
    assert.equal(parsedAttr.deviceId, browserDeviceId);

    const cbRes = await app.request(
      `/auth/callback?code=ok-code&state=${encodeURIComponent(authUrl.searchParams.get('state')!)}`,
      {
        headers: {
          Cookie: `om_oidc_tx=${encodeURIComponent(txCookie)}; om_auth_attr=${encodeURIComponent(attrCookieRaw)}`,
        },
      },
    );
    assert.equal(cbRes.status, 302);
    assert.equal(signInCalls.length, 1);
    assert.equal(signInCalls[0]?.outcome, 'success');
    assert.equal(signInCalls[0]?.deviceId, browserDeviceId);
    assert.ok(signInCalls[0]?.userId);

    // 2. Cancelled callback also forwards deviceId + hookId
    const entryId = '22222222-3333-4444-8555-666666666666';
    const cancelLoginRes = await app.request(
      `/auth/login?returnTo=/studio&hook_id=bf_banner&entry_id=${entryId}&device_id=${encodeURIComponent(browserDeviceId)}`,
    );
    assert.equal(cancelLoginRes.status, 302);
    const cancelAuthUrl = new URL(cancelLoginRes.headers.get('location')!);
    const cancelCookies = cancelLoginRes.headers.getSetCookie();
    const cancelTx = extractCookieValue(cancelCookies, 'om_oidc_tx')!;
    const cancelAttr = extractCookieValue(cancelCookies, 'om_auth_attr')!;
    const cancelCbRes = await app.request(
      `/auth/callback?error=access_denied&state=${encodeURIComponent(cancelAuthUrl.searchParams.get('state')!)}`,
      {
        headers: {
          Cookie: `om_oidc_tx=${encodeURIComponent(cancelTx)}; om_auth_attr=${encodeURIComponent(cancelAttr)}`,
        },
      },
    );
    assert.equal(cancelCbRes.status, 302);
    assert.equal(signInCalls.length, 2);
    assert.equal(signInCalls[1]?.outcome, 'cancelled');
    assert.equal(signInCalls[1]?.hookId, 'bf_banner');
    assert.equal(signInCalls[1]?.entryId, entryId);
    assert.equal(signInCalls[1]?.deviceId, browserDeviceId);
  });
});
