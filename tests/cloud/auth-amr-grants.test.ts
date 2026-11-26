import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import {
  AmrIdentityClient,
  InMemoryAuthCache,
  InMemoryAuthStore,
  buildOAuth21Config,
  createAuthMiddleware,
  createAuthRoutes,
  createBrowserSession,
  createMcpBearerAuthMiddleware,
  generatePkcePair,
  getAuthContext,
  type AuthEnv,
} from '../../src/auth/index.ts';
import {
  formatRedirectHostLabel,
  isAllowedOAuthRedirectUri,
} from '../../src/auth/oauth21.ts';
import { parseConfig } from '../../src/infra/config.ts';
import { CloudError } from '../../src/contracts/errors.ts';
import { OpenDesignModelGateway } from '../../src/services/opendesign-adapter.ts';

function oidcConfig(overrides: Record<string, string> = {}) {
  return parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    APP_PUBLIC_ORIGIN: 'https://motion.example.test',
    AUTH_MODE: 'oidc',
    SESSION_SECRET: '0'.repeat(32),
    OIDC_ISSUER: 'https://amr-api.example.test/api/auth',
    OIDC_CLIENT_ID: 'openmotion-cloud',
    OIDC_CLIENT_SECRET: 'ephemeral-test-client-secret',
    OPENDESIGN_API_URL: 'https://amr-api.example.test',
    OPENDESIGN_INTERNAL_API_TOKEN: 'ephemeral-internal-token',
    OAUTH_DCR_RATE_LIMIT_PER_MIN: '3',
    MODEL_GATEWAY_MODE: 'mock',
    ...overrides,
  });
}

describe('AMR Identity Lookup, 60s Multi-Workspace Cache, Ban/503 Handling, DCR Anti-Abuse & Connected Apps', () => {
  it('correlates unavailable responses with a single classified diagnostic without logging identity or upstream content', async () => {
    const cases: Array<[string, number | undefined, typeof fetch]> = [
      ['transport', undefined, async () => { throw new Error('sensitive transport detail'); }],
      ['timeout', undefined, async (_input, init) => {
        await delay(1_000, undefined, { signal: init!.signal! });
        throw new Error('expected the lookup to time out');
      }],
      ['upstream_http', 429, async () => new Response('private upstream body', { status: 429 })],
      ['invalid_response', 200, async () => new Response('invalid JSON')],
      ['missing_workspace', 200, async () => Response.json({ active: true })],
    ];
    const ids = new Set<string>();
    for (const [reason, upstreamStatus, fetcher] of cases) {
      const warnings: unknown[] = [];
      const client = new AmrIdentityClient({
        apiUrl: 'https://identity.example.test', internalToken: 'private-token', fetcher,
        timeoutMs: reason === 'timeout' ? 1 : 5_000,
        logger: { warn: (_message, fields) => warnings.push(fields) },
      });
      await assert.rejects(client.lookupIdentity('private-user'), (error: unknown) => {
        assert.ok(error instanceof CloudError);
        const diagnosticId = error.details?.diagnosticId;
        assert.ok(typeof diagnosticId === 'string' && !ids.has(diagnosticId));
        ids.add(diagnosticId);
        assert.equal(error.status, 503);
        assert.equal(error.toJSON().errorCode, 'auth_unavailable');
        assert.deepEqual(warnings, [{ diagnosticId, reason, upstreamStatus }]);
        return true;
      });
    }
  });

  it('isolates 60s identity cache by (authUserId, externalWorkspaceId), enforces ban=401 and AMR-down=503', async () => {
    const config = oidcConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();

    let amrStatus: 'active' | 'banned' | 'down' = 'active';
    const lookupCalls: string[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('x-internal-token'), 'ephemeral-internal-token');
      assert.equal(headers.get('authorization'), null);
      lookupCalls.push(url);

      if (amrStatus === 'down') {
        throw new Error('ECONNREFUSED');
      }

      const parsed = new URL(url);
      const wsParam = parsed.searchParams.get('workspaceId') ?? 'amr-ws-a';

      if (amrStatus === 'banned') {
        return new Response(
          JSON.stringify({
            active: false,
            status: 'banned',
            authUserId: 'auth-alice',
            appUserId: 'app-alice',
            workspace: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      const isTeam = wsParam === 'amr-ws-b';
      return new Response(
        JSON.stringify({
          active: true,
          status: 'active',
          authUserId: 'auth-alice',
          appUserId: 'app-alice',
          email: 'alice@example.com',
          name: 'Alice',
          image: 'https://cdn.example.test/alice.png',
          workspace: {
            workspaceId: isTeam ? 'amr-ws-b' : 'amr-ws-a',
            workspaceName: isTeam ? 'Team Studio' : 'Personal',
            workspaceType: isTeam ? 'team' : 'personal',
            workspaceMemberId: isTeam ? 'mem-b' : 'mem-a',
            role: isTeam ? 'member' : 'owner',
            lifecycleState: 'active',
            effectiveWriteAccess: 'writable',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const warnings: unknown[] = [];
    const amrIdentity = new AmrIdentityClient({
      apiUrl: 'https://amr-api.example.test',
      internalToken: 'ephemeral-internal-token',
      cache,
      cacheTtlSec: 60,
      fetcher: mockFetch,
      logger: { warn: (_message, fields) => warnings.push(fields) },
    });

    // Project both AMR workspaces for Alice
    const wsA = await store.projectAmrUserAndWorkspace({
      oidcSub: 'auth-alice',
      appUserId: 'app-alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      externalWorkspaceId: 'amr-ws-a',
      workspaceName: 'Personal',
      role: 'owner',
    });
    const wsB = await store.projectAmrUserAndWorkspace({
      oidcSub: 'auth-alice',
      appUserId: 'app-alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      externalWorkspaceId: 'amr-ws-b',
      workspaceName: 'Team Studio',
      role: 'editor',
    });

    const session = await createBrowserSession(store, {
      userId: wsA.user.id,
      workspaceId: wsA.workspace.id,
    });

    const app = new Hono<AuthEnv>();
    const mw = createAuthMiddleware({ config, store, cache, amrIdentity });
    app.get('/probe', mw, (c) => {
      const auth = getAuthContext(c);
      return c.json({
        userId: auth.userId,
        appUserId: auth.appUserId,
        workspaceId: auth.workspaceId,
        externalWorkspaceId: auth.externalWorkspaceId,
        amrWorkspaceMemberId: auth.amrWorkspaceMemberId,
        amrWorkspaceRole: auth.amrWorkspaceRole,
        role: auth.role,
        entry: auth.entry,
      });
    });

    // 1. Access workspace A -> calls AMR once
    const rA1 = await app.request('/probe', {
      headers: { Cookie: `om_session=${session.token}` },
    });
    assert.equal(rA1.status, 200);
    const bodyA1 = (await rA1.json()) as Record<string, unknown>;
    assert.equal(bodyA1.externalWorkspaceId, 'amr-ws-a');
    assert.equal(bodyA1.amrWorkspaceMemberId, 'mem-a');
    assert.equal(bodyA1.role, 'owner');
    assert.equal(lookupCalls.length, 1);

    // 2. Access workspace B within 60s -> distinct cache key, gets mem-b + editor role!
    const rB1 = await app.request('/probe', {
      headers: {
        Cookie: `om_session=${session.token}`,
        'X-OpenMotion-Workspace-Id': wsB.workspace.id,
      },
    });
    assert.equal(rB1.status, 200);
    const bodyB1 = (await rB1.json()) as Record<string, unknown>;
    assert.equal(bodyB1.externalWorkspaceId, 'amr-ws-b');
    assert.equal(bodyB1.amrWorkspaceMemberId, 'mem-b');
    assert.equal(bodyB1.amrWorkspaceRole, 'member');
    assert.equal(bodyB1.role, 'editor');
    assert.equal(lookupCalls.length, 2);

    // 3. Re-access workspace A -> served from cache (no extra AMR hit)
    const rA2 = await app.request('/probe', {
      headers: { Cookie: `om_session=${session.token}` },
    });
    assert.equal(rA2.status, 200);
    assert.equal(lookupCalls.length, 2);

    // 4. Clear cache & ban Alice -> returns 401 auth_required
    await cache.del('om:amr:id:auth-alice:amr-ws-a');
    amrStatus = 'banned';
    const rBanned = await app.request('/probe', {
      headers: { Cookie: `om_session=${session.token}` },
    });
    assert.equal(rBanned.status, 401);
    const bodyBanned = (await rBanned.json()) as Record<string, unknown>;
    assert.equal(bodyBanned.errorCode, 'auth_required');
    assert.deepEqual(warnings, []);

    // 5. AMR unreachable -> returns 503 auth_unavailable (does NOT clear session)
    amrStatus = 'down';
    const rDown = await app.request('/probe', {
      headers: { Cookie: `om_session=${session.token}` },
    });
    assert.equal(rDown.status, 503);
    const bodyDown = await rDown.json();
    assert.equal(bodyDown.code, 'AUTH_UNAVAILABLE');
    assert.equal(bodyDown.errorCode, 'auth_unavailable');
    assert.equal(typeof bodyDown.details.diagnosticId, 'string');
    assert.deepEqual(warnings, [{ diagnosticId: bodyDown.details.diagnosticId, reason: 'transport', upstreamStatus: undefined }]);
  });

  it('enforces DCR redirect_uri allowlist, per-IP rate limiting, unused client cleanup, and connected-app revocation independent of web logout', async () => {
    const config = oidcConfig({ OAUTH_DCR_RATE_LIMIT_PER_MIN: '3' });
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();
    const oauth21 = buildOAuth21Config(config);

    const { user, workspace } = store.seedWorkspace({
      email: 'alice@example.com',
      displayName: 'Alice',
    });
    const session = await createBrowserSession(store, {
      userId: user.id,
      workspaceId: workspace.id,
    });

    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache, oauth21 }));
    app.get('/mcp-probe', createMcpBearerAuthMiddleware({ config, store, cache, oauth21 }), (c) => {
      const auth = getAuthContext(c);
      return c.json({ ok: true, clientId: auth.clientId, entry: auth.entry });
    });

    // 1. Unallowlisted HTTPS redirect URI is rejected
    const badHttps = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
      body: JSON.stringify({
        client_name: 'Phish App',
        redirect_uris: ['https://evil.example.com/callback'],
      }),
    });
    assert.equal(badHttps.status, 400);

    // 2. Loopback redirect URI (like Codex CLI with random suffix) is accepted
    const goodLoopback = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
      body: JSON.stringify({
        client_name: 'Codex CLI',
        redirect_uris: ['http://127.0.0.1:51234/callback/abc123def456'],
      }),
    });
    assert.equal(goodLoopback.status, 201);
    const client = (await goodLoopback.json()) as { client_id: string };

    // 3. Register an unused client (3rd request from same IP succeeds; 4th hits rate limit 429!)
    const unusedReg = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
      body: JSON.stringify({
        client_name: 'Abandoned Client',
        redirect_uris: ['http://127.0.0.1:59999/callback'],
      }),
    });
    assert.equal(unusedReg.status, 201);
    const unusedClient = (await unusedReg.json()) as { client_id: string };

    const rateLimited = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
      body: JSON.stringify({
        client_name: 'Spam Client',
        redirect_uris: ['http://127.0.0.1:59998/callback'],
      }),
    });
    assert.equal(rateLimited.status, 429);

    // 4a. Consent deny response includes RFC 9207 `iss` parameter alongside error and state
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const denyAuthzUrl =
      `/oauth/authorize?client_id=${encodeURIComponent(client.client_id)}` +
      `&redirect_uri=${encodeURIComponent('http://127.0.0.1:51234/callback/abc123def456')}` +
      `&response_type=code&code_challenge=${encodeURIComponent(codeChallenge)}` +
      `&code_challenge_method=S256&state=st-deny&resource=${encodeURIComponent('https://motion.example.test/mcp')}`;

    const denyConsentRes = await app.request(denyAuthzUrl, {
      headers: { Cookie: `om_session=${session.token}` },
    });
    assert.equal(denyConsentRes.status, 200);
    const denyHtml = await denyConsentRes.text();
    const denyTokenMatch = denyHtml.match(/name="consent_token" value="([^"]+)"/);
    assert.ok(denyTokenMatch);

    const denyRes = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `om_session=${session.token}`,
        Origin: 'https://motion.example.test',
      },
      body: new URLSearchParams({
        consent_token: denyTokenMatch[1],
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:51234/callback/abc123def456',
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: 'st-deny',
        resource: 'https://motion.example.test/mcp',
        decision: 'deny',
      }).toString(),
    });
    assert.equal(denyRes.status, 302);
    const denyCallbackUrl = new URL(denyRes.headers.get('location')!);
    assert.equal(denyCallbackUrl.searchParams.get('error'), 'access_denied');
    assert.equal(denyCallbackUrl.searchParams.get('state'), 'st-deny');
    assert.equal(denyCallbackUrl.searchParams.get('iss'), 'https://motion.example.test');

    // 4b. Complete OAuth authorize + consent + token exchange for Codex CLI
    const authzUrl =
      `/oauth/authorize?client_id=${encodeURIComponent(client.client_id)}` +
      `&redirect_uri=${encodeURIComponent('http://127.0.0.1:51234/callback/abc123def456')}` +
      `&response_type=code&code_challenge=${encodeURIComponent(codeChallenge)}` +
      `&code_challenge_method=S256&state=st-1&resource=${encodeURIComponent('https://motion.example.test/mcp')}`;

    const consentRes = await app.request(authzUrl, {
      headers: { Cookie: `om_session=${session.token}` },
    });
    assert.equal(consentRes.status, 200);
    const html = await consentRes.text();
    assert.ok(html.includes('alice@example.com'));
    assert.ok(html.includes('应用名未经验证'));
    assert.ok(html.includes('Local application (127.0.0.1)'));
    assert.ok(html.includes('换一个账号'));

    const consentTokenMatch = html.match(/name="consent_token" value="([^"]+)"/);
    assert.ok(consentTokenMatch);

    const approveRes = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `om_session=${session.token}`,
        Origin: 'https://motion.example.test',
      },
      body: new URLSearchParams({
        consent_token: consentTokenMatch[1],
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:51234/callback/abc123def456',
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: 'st-1',
        resource: 'https://motion.example.test/mcp',
        decision: 'approve',
      }).toString(),
    });
    assert.equal(approveRes.status, 302);
    const callbackUrl = new URL(approveRes.headers.get('location')!);
    assert.equal(callbackUrl.searchParams.get('iss'), 'https://motion.example.test');
    const code = callbackUrl.searchParams.get('code')!;

    const tokRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        redirect_uri: 'http://127.0.0.1:51234/callback/abc123def456',
        code_verifier: codeVerifier,
      }).toString(),
    });
    assert.equal(tokRes.status, 200);
    const tokens = (await tokRes.json()) as { access_token: string; refresh_token: string };

    // 5. Unused client cleanup removes Abandoned Client, keeps Codex CLI
    const cleaned = await store.cleanupUnusedOAuthClients(new Date(Date.now() + 60_000));
    assert.equal(cleaned, 1);
    assert.equal(await store.findOAuthClient(unusedClient.client_id), null);
    assert.ok(await store.findOAuthClient(client.client_id));

    // 6. Connected apps endpoint lists Codex CLI
    const listRes = await app.request('/motion-api/connections', {
      headers: { Cookie: `om_session=${session.token}` },
    });
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as { connections: Array<{ clientId: string; redirectHost: string }> };
    assert.equal(listBody.connections.length, 1);
    assert.equal(listBody.connections[0].clientId, client.client_id);
    assert.equal(listBody.connections[0].redirectHost, 'Local application (127.0.0.1)');

    // 7. Web logout does NOT invalidate agent token
    const logoutRes = await app.request('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `om_session=${session.token}`,
        Origin: 'https://motion.example.test',
      },
    });
    assert.equal(logoutRes.status, 200);

    const mcpStillOk = await app.request('/mcp-probe', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    assert.equal(mcpStillOk.status, 200);
    assert.deepEqual(await mcpStillOk.json(), { ok: true, clientId: client.client_id, entry: 'mcp' });

    // 8. Revoking connected app in a new web session invalidates BOTH access and refresh tokens!
    const session2 = await createBrowserSession(store, {
      userId: user.id,
      workspaceId: workspace.id,
    });
    const revokeRes = await app.request(`/motion-api/connections/${encodeURIComponent(client.client_id)}`, {
      method: 'DELETE',
      headers: {
        Cookie: `om_session=${session2.token}`,
        Origin: 'https://motion.example.test',
      },
    });
    assert.equal(revokeRes.status, 200);

    const mcpRevoked = await app.request('/mcp-probe', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    assert.equal(mcpRevoked.status, 401);

    const refreshRevoked = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
      }).toString(),
    });
    assert.equal(refreshRevoked.status, 400);
  });

  it('calls AMR /api/internal/billing/summary/:appUserId with x-internal-token and without Authorization header', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const gateway = new OpenDesignModelGateway({
      apiUrl: 'https://amr-api.example.test',
      linkUrl: 'https://amr-link.example.test',
      internalToken: 'ephemeral-internal-token',
      billingSyncEnabled: true,
      fetcher: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        seen.push({ url, headers });
        return new Response(
          JSON.stringify({
            membershipTier: 'pro',
            totalAvailableCreditsUsd: '12.50',
            balanceUsd: '12.50',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const summary = await gateway.getBillingSummary({
      workspaceId: 'local-ws-1',
      externalWorkspaceId: 'amr-ws-9',
      appUserId: 'app-user-9',
      amrWorkspaceMemberId: 'mem-9',
      amrWorkspaceRole: 'owner',
      amrWorkspaceLifecycleState: 'active',
    });

    assert.equal(summary.plan, 'pro');
    assert.equal(summary.mediaEntitlement, 'included');
    assert.equal(summary.balanceUsd, '12.50');
    assert.equal(summary.hasBalance, true);
    assert.equal(seen[0].url, 'https://amr-api.example.test/api/internal/billing/summary/app-user-9');
    assert.equal(seen[0].headers['x-internal-token'], 'ephemeral-internal-token');
    assert.equal(seen[0].headers['x-vela-workspace-id'], 'amr-ws-9');
    assert.equal(seen[0].headers.authorization, undefined);
  });

  it('maps AMR null membershipTier to free plan, recognizes team_* tiers, and surfaces 403 errorStatus', async () => {
    const gatewayFree = new OpenDesignModelGateway({
      apiUrl: 'https://amr-api.example.test',
      linkUrl: 'https://amr-link.example.test',
      internalToken: 'ephemeral-internal-token',
      billingSyncEnabled: true,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            membershipTier: null,
            subscriptionStatus: null,
            subscriptionEntitlementStatus: null,
            totalAvailableCreditsUsd: '0.00',
            balanceUsd: '0.00',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const freeSummary = await gatewayFree.getBillingSummary({
      workspaceId: 'local-ws-free',
      externalWorkspaceId: 'amr-ws-free',
      appUserId: 'app-user-free',
    });
    assert.equal(freeSummary.plan, 'free');
    assert.equal(freeSummary.mediaEntitlement, 'not-included');
    assert.equal(freeSummary.balanceUsd, '0.00');
    assert.equal(freeSummary.unavailable, undefined);

    const gatewayTeam = new OpenDesignModelGateway({
      apiUrl: 'https://amr-api.example.test',
      linkUrl: 'https://amr-link.example.test',
      internalToken: 'ephemeral-internal-token',
      billingSyncEnabled: true,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            membershipTier: 'team_pro',
            subscriptionEntitlementStatus: 'active',
            totalAvailableCreditsUsd: '42.50',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const teamSummary = await gatewayTeam.getBillingSummary({
      workspaceId: 'local-ws-team',
      externalWorkspaceId: 'amr-ws-team',
      appUserId: 'app-user-team',
    });
    assert.equal(teamSummary.plan, 'team_pro');
    assert.equal(teamSummary.mediaEntitlement, 'included');
    assert.equal(teamSummary.balanceUsd, '42.50');

    const gatewayDenied = new OpenDesignModelGateway({
      apiUrl: 'https://amr-api.example.test',
      linkUrl: 'https://amr-link.example.test',
      internalToken: 'ephemeral-internal-token',
      billingSyncEnabled: true,
      fetcher: async () =>
        new Response(JSON.stringify({ error: 'workspace_billing_scope_forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    const deniedSummary = await gatewayDenied.getBillingSummary({
      workspaceId: 'local-ws-denied',
      externalWorkspaceId: 'amr-ws-denied',
      appUserId: 'app-user-denied',
    });
    assert.equal(deniedSummary.unavailable, true);
    assert.equal(deniedSummary.errorStatus, 403);
  });

  it('allows RFC 8252 native-app custom URI schemes and major cloud MCP hosts in OAuth DCR while blocking unsafe schemes and untrusted domains', async () => {
    for (const allowed of [
      'cursor://anysphere.cursor-mcp/oauth/callback',
      'vscode://openmotion.client/auth',
      'openmotion://auth/callback',
      'com.example.agent:/oauth/cb',
      'io.nexu.openmotion://auth/callback',
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/api/mcp/auth_callback',
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'https://chat.openai.com/oauth/callback',
      'https://app.cursor.com/oauth/callback',
      'https://motion.open-design.ai/oauth/callback',
      'http://127.0.0.1:51234/callback',
    ]) {
      assert.equal(isAllowedOAuthRedirectUri(allowed), true, `expected allowed: ${allowed}`);
    }

    assert.equal(
      isAllowedOAuthRedirectUri('https://staging.example.test/oauth/callback', ['*.example.test']),
      true,
      'explicit OAUTH_DCR_ALLOWED_HTTPS_HOSTS wildcard must admit matching staging hosts',
    );

    for (const blocked of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'jar:file:///etc/passwd!/x',
      'ms-msdt:/id PCWDiagnostic',
      'search-ms:query=test',
      'ms-officecmd:/x',
      'ms-browser-extension://abc/x',
      'view-source:https://example.com',
      'chrome-extension://abcdef/cb',
      'a..b://cb',
      'cursor://',
      'cursor://anysphere.cursor-mcp/oauth/callback#frag',
      'cursor://user:pass@anysphere.cursor-mcp/oauth/callback',
      'https://evil.example.com/callback',
      'http://evil.example.com/callback',
    ]) {
      assert.equal(isAllowedOAuthRedirectUri(blocked), false, `expected blocked: ${blocked}`);
    }

    assert.equal(
      formatRedirectHostLabel('cursor://anysphere.cursor-mcp/oauth/callback'),
      'Desktop app (cursor://anysphere.cursor-mcp)',
    );
    assert.equal(
      formatRedirectHostLabel('com.example.agent:/oauth/cb'),
      'Desktop app (com.example.agent)',
    );

    const config = oidcConfig({ OAUTH_DCR_RATE_LIMIT_PER_MIN: '30' });
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();
    const oauth21 = buildOAuth21Config(config);
    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache, oauth21 }));

    const cursorDcr = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.55' },
      body: JSON.stringify({
        client_name: 'Cursor',
        redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'],
      }),
    });
    assert.equal(cursorDcr.status, 201);

    const jsDcr = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.55' },
      body: JSON.stringify({
        client_name: 'XSS',
        redirect_uris: ['javascript:alert(1)'],
      }),
    });
    assert.equal(jsDcr.status, 400);
  });
});
