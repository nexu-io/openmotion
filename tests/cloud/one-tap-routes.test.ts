import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import {
  AmrIdentityClient,
  InMemoryAuthCache,
  InMemoryAuthStore,
  ONETAP_CTX_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  createAuthMiddleware,
  createAuthRoutes,
  createBrowserSession,
  createPat,
  type AuthEnv,
} from '../../src/auth/index.ts';
import { parseConfig, type AppConfig } from '../../src/infra/config.ts';
import { createAccountRoutes } from '../../src/routes/account.ts';
import { MockModelGateway } from '../../src/services/mock-model-adapter.ts';

const PUBLIC_ORIGIN = 'https://motion.open-design.ai';
const AMR_API_URL = 'https://amr-api.open-design.ai';
const INTERNAL_TOKEN = 'test-internal-s2s-token';

function makeConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    WORKER_ROLE: 'api',
    APP_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://amr-api.open-design.ai/oauth',
    OIDC_CLIENT_ID: 'openmotion-cloud-client',
    OIDC_CLIENT_SECRET: 'ephemeral-test-client-secret',
    SESSION_SECRET: '0'.repeat(32),
    MODEL_GATEWAY_MODE: 'mock',
    OPENDESIGN_API_URL: AMR_API_URL,
    OPENDESIGN_CONSOLE_URL: 'https://open-design.ai/cloud',
    OPENDESIGN_PRICING_URL: 'https://open-design.ai/pricing',
    OPENDESIGN_INTERNAL_API_TOKEN: INTERNAL_TOKEN,
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  });
}

function extractCookieValue(setCookieHeaders: string[], name: string): string | null {
  for (const header of setCookieHeaders) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(header.trim());
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('Same-Origin Google One Tap & Upgrade Handoff Routes', () => {
  it('does not mount One Tap routes in AUTH_MODE=dev or without amrIdentity', async () => {
    const store = new InMemoryAuthStore();

    const devApp = new Hono<AuthEnv>();
    devApp.route('/', createAuthRoutes({ config: makeConfig({ AUTH_MODE: 'dev' }), store }));
    const devRes = await devApp.request('/auth/one-tap/challenge', {
      method: 'POST',
      headers: { Origin: PUBLIC_ORIGIN },
    });
    assert.equal(devRes.status, 404);

    const noAmrApp = new Hono<AuthEnv>();
    noAmrApp.route('/', createAuthRoutes({ config: makeConfig(), store }));
    const noAmrRes = await noAmrApp.request('/auth/one-tap/challenge', {
      method: 'POST',
      headers: { Origin: PUBLIC_ORIGIN },
    });
    assert.equal(noAmrRes.status, 404);
  });

  it('runs full challenge -> exchange -> session projection -> /auth/me & account/summary with appUserId', async () => {
    const config = makeConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();

    const amrRequests: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
    let savedBindingHash = '';

    const amrIdentity = new AmrIdentityClient({
      apiUrl: AMR_API_URL,
      internalToken: INTERNAL_TOKEN,
      cache,
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        amrRequests.push({ url, method, headers, body });

        assert.equal(headers.get('x-internal-token'), INTERNAL_TOKEN);
        assert.equal(headers.get('authorization'), null);

        if (url === `${AMR_API_URL}/api/internal/auth/one-tap/challenge` && method === 'POST') {
          const req = body as Record<string, unknown>;
          savedBindingHash = String(req.browserBindingHash);
          return Response.json({
            challengeId: 'otc_motion_123',
            nonce: 'nonce_abc_xyz',
            clientId: 'google-client-id.apps.googleusercontent.com',
            expiresAt: '2026-11-24T12:00:00.000Z',
          });
        }

        if (url === `${AMR_API_URL}/api/internal/auth/one-tap/exchange` && method === 'POST') {
          const req = body as Record<string, unknown>;
          assert.equal(req.challengeId, 'otc_motion_123');
          assert.equal(req.idToken, 'google.id.token.jwt');
          assert.equal(req.expectedOrigin, PUBLIC_ORIGIN);
          assert.equal(req.surface, 'motion_web');
          assert.equal(req.browserBindingHash, savedBindingHash);
          assert.equal(req.referralCode, 'REF42');
          assert.deepEqual(req.attribution, {
            utmSource: 'twitter',
            utmCampaign: 'opengame_launch',
            landingPath: '/templates',
          });
          return Response.json({
            ok: true,
            authUserId: 'ba_usr_777',
            appUserId: 'usr_app_777',
            email: 'creator@example.com',
            name: 'Creator One',
            image: 'https://example.com/avatar.png',
            isNewUser: true,
            planTier: 'free',
          });
        }

        if (url.startsWith(`${AMR_API_URL}/api/internal/identity/ba_usr_777`) && method === 'GET') {
          return Response.json({
            active: true,
            status: 'active',
            authUserId: 'ba_usr_777',
            appUserId: 'usr_app_777',
            email: 'creator@example.com',
            name: 'Creator One',
            image: 'https://example.com/avatar.png',
            workspace: {
              workspaceId: 'ws_amr_777',
              workspaceName: 'Creator Workspace',
              workspaceType: 'personal',
              workspaceMemberId: 'wm_777',
              role: 'owner',
              lifecycleState: 'active',
              effectiveWriteAccess: 'writable',
            },
          });
        }

        return new Response('Not Found', { status: 404 });
      }) as typeof fetch,
    });

    const app = new Hono<AuthEnv>();
    const authDeps = { config, store, cache, amrIdentity };
    app.route('/', createAuthRoutes(authDeps));
    const authMiddleware = createAuthMiddleware(authDeps);
    app.use('/motion-api/account/*', authMiddleware);
    app.route(
      '/motion-api/account',
      createAccountRoutes({
        config,
        authStore: store,
        gateway: new MockModelGateway(),
        cache,
      }),
    );

    // 1. CSRF Origin rejection on challenge
    const badOriginChallenge = await app.request('/auth/one-tap/challenge', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'att-bad' }),
    });
    assert.equal(badOriginChallenge.status, 403);
    assert.equal(((await badOriginChallenge.json()) as { code: string }).code, 'ORIGIN_NOT_ALLOWED');

    // 2. Valid challenge request
    const challengeRes = await app.request('/auth/one-tap/challenge', {
      method: 'POST',
      headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'att-1' }),
    });
    assert.equal(challengeRes.status, 200);
    const challengeBody = (await challengeRes.json()) as {
      challengeId: string;
      nonce: string;
      clientId: string;
      expiresAt: string;
    };
    assert.deepEqual(challengeBody, {
      challengeId: 'otc_motion_123',
      nonce: 'nonce_abc_xyz',
      clientId: 'google-client-id.apps.googleusercontent.com',
      expiresAt: '2026-11-24T12:00:00.000Z',
    });

    const challengeCookies = challengeRes.headers.getSetCookie();
    const ctxHeader = challengeCookies.find((h) => h.startsWith(`${ONETAP_CTX_COOKIE_NAME}=`))!;
    assert.ok(ctxHeader, 'Expected om_onetap_ctx cookie');
    assert.ok(ctxHeader.includes('HttpOnly'));
    assert.ok(ctxHeader.includes('SameSite=Lax'));
    assert.ok(ctxHeader.includes('Path=/auth/one-tap'));
    assert.ok(ctxHeader.includes('Secure'));
    const ctxToken = extractCookieValue(challengeCookies, ONETAP_CTX_COOKIE_NAME)!;
    assert.equal(sha256Hex(ctxToken), savedBindingHash);

    // 3. Exchange rejects missing om_onetap_ctx cookie
    const missingCookieRes = await app.request('/auth/one-tap', {
      method: 'POST',
      headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: 'otc_motion_123', idToken: 'google.id.token.jwt' }),
    });
    assert.equal(missingCookieRes.status, 400);
    assert.equal(((await missingCookieRes.json()) as { code: string }).code, 'CHALLENGE_INVALID');

    // 4. Valid exchange issues om_session, clears om_onetap_ctx, and returns user with appUserId
    const exchangeRes = await app.request('/auth/one-tap', {
      method: 'POST',
      headers: {
        Origin: PUBLIC_ORIGIN,
        'content-type': 'application/json',
        Cookie: `${ONETAP_CTX_COOKIE_NAME}=${ctxToken}`,
      },
      body: JSON.stringify({
        challengeId: 'otc_motion_123',
        idToken: 'google.id.token.jwt',
        referralCode: 'REF42',
        attribution: {
          utmSource: 'twitter',
          utmCampaign: 'opengame_launch',
          landingPath: '/templates',
        },
      }),
    });
    assert.equal(exchangeRes.status, 200);
    const exchangeCookies = exchangeRes.headers.getSetCookie();
    const sessionToken = extractCookieValue(exchangeCookies, SESSION_COOKIE_NAME)!;
    assert.ok(sessionToken && sessionToken.length >= 32);
    const clearedCtx = exchangeCookies.find((h) => h.startsWith(`${ONETAP_CTX_COOKIE_NAME}=`))!;
    assert.ok(clearedCtx.includes('Max-Age=0'), 'Expected om_onetap_ctx to be cleared');

    const exchangePayload = (await exchangeRes.json()) as {
      authenticated: boolean;
      user: { id: string; appUserId: string; email: string; displayName: string };
      activeWorkspaceId: string;
      isNewUser: boolean;
      planTier: string;
    };
    assert.equal(exchangePayload.authenticated, true);
    assert.equal(exchangePayload.user.appUserId, 'usr_app_777');
    assert.equal(exchangePayload.user.email, 'creator@example.com');
    assert.equal(exchangePayload.user.displayName, 'Creator One');
    assert.equal(exchangePayload.isNewUser, true);
    assert.equal(exchangePayload.planTier, 'free');
    assert.ok(exchangePayload.activeWorkspaceId);

    // 5. GET /auth/me exposes user.appUserId
    const meRes = await app.request('/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    });
    assert.equal(meRes.status, 200);
    const meBody = (await meRes.json()) as { user: { id: string; appUserId: string | null } };
    assert.equal(meBody.user.id, exchangePayload.user.id);
    assert.equal(meBody.user.appUserId, 'usr_app_777');

    // 6. GET /motion-api/account/summary exposes user.appUserId
    const summaryRes = await app.request('/motion-api/account/summary', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    });
    assert.equal(summaryRes.status, 200);
    const summaryBody = (await summaryRes.json()) as { user: { id: string; appUserId: string | null } };
    assert.equal(summaryBody.user.id, exchangePayload.user.id);
    assert.equal(summaryBody.user.appUserId, 'usr_app_777');
  });

  it('passes through 400/403/409 error codes and maps AMR unreachability to 503', async () => {
    const config = makeConfig();
    const store = new InMemoryAuthStore();

    const errorCases: Array<{
      label: string;
      status: number;
      code: string;
      message: string;
      networkThrow?: boolean;
    }> = [
      { label: '400 INVALID_ID_TOKEN', status: 400, code: 'INVALID_ID_TOKEN', message: 'Invalid token' },
      { label: '403 ACCOUNT_BANNED', status: 403, code: 'ACCOUNT_BANNED', message: 'Account banned' },
      { label: '403 ACCOUNT_FROZEN', status: 403, code: 'ACCOUNT_FROZEN', message: 'Account frozen' },
      {
        label: '403 EMAIL_DOMAIN_BLOCKED',
        status: 403,
        code: 'EMAIL_DOMAIN_BLOCKED',
        message: 'Domain blocked',
      },
      {
        label: '409 LINK_CONFIRM_REQUIRED',
        status: 409,
        code: 'LINK_CONFIRM_REQUIRED',
        message: 'Confirm link',
      },
      {
        label: '503 ONE_TAP_UNAVAILABLE',
        status: 503,
        code: 'ONE_TAP_UNAVAILABLE',
        message: 'One Tap disabled',
      },
      {
        label: 'network error -> 503 AUTH_UNAVAILABLE',
        status: 503,
        code: 'AUTH_UNAVAILABLE',
        message: 'Unavailable',
        networkThrow: true,
      },
    ];

    for (const tc of errorCases) {
      const amrIdentity = new AmrIdentityClient({
        apiUrl: AMR_API_URL,
        internalToken: INTERNAL_TOKEN,
        fetcher: (async () => {
          if (tc.networkThrow) {
            throw new Error('ECONNREFUSED');
          }
          return Response.json({ code: tc.code, message: tc.message }, { status: tc.status });
        }) as typeof fetch,
      });

      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store, amrIdentity }));

      const res = await app.request('/auth/one-tap', {
        method: 'POST',
        headers: {
          Origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
          Cookie: `${ONETAP_CTX_COOKIE_NAME}=ctx-token-1`,
        },
        body: JSON.stringify({ challengeId: 'otc_1', idToken: 'jwt_1' }),
      });

      assert.equal(res.status, tc.status, `Unexpected status for ${tc.label}`);
      const payload = (await res.json()) as { code: string; message: string };
      assert.equal(payload.code, tc.code, `Unexpected code for ${tc.label}`);
    }
  });

  it('redirects GET /auth/upgrade-handoff via AMR handoff-ticket and degrades safely to Pricing URL', async () => {
    const config = makeConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();

    const projected = await store.projectAmrUserAndWorkspace({
      oidcSub: 'ba_usr_upgrade',
      appUserId: 'usr_app_upgrade',
      email: 'free@example.com',
      displayName: 'Free User',
      avatarUrl: null,
      externalWorkspaceId: 'ws_amr_upgrade',
      workspaceName: 'Free Workspace',
      role: 'owner',
    });
    const session = await createBrowserSession(store, {
      userId: projected.user.id,
      workspaceId: projected.workspace.id,
    });

    let ticketMode: 'ok' | 'untrusted' | 'unavailable' = 'ok';
    const capturedTicketBodies: Array<Record<string, unknown>> = [];

    const amrIdentity = new AmrIdentityClient({
      apiUrl: AMR_API_URL,
      internalToken: INTERNAL_TOKEN,
      cache,
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith(`${AMR_API_URL}/api/internal/identity/ba_usr_upgrade`)) {
          return Response.json({
            active: true,
            status: 'active',
            authUserId: 'ba_usr_upgrade',
            appUserId: 'usr_app_upgrade',
            email: 'free@example.com',
            name: 'Free User',
            image: null,
            workspace: {
              workspaceId: 'ws_amr_upgrade',
              workspaceName: 'Free Workspace',
              workspaceType: 'personal',
              workspaceMemberId: 'wm_u',
              role: 'owner',
              lifecycleState: 'active',
              effectiveWriteAccess: 'writable',
            },
          });
        }
        if (url === `${AMR_API_URL}/api/internal/auth/one-tap/handoff-ticket`) {
          capturedTicketBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
          if (ticketMode === 'unavailable') {
            return new Response('Service Unavailable', { status: 503 });
          }
          if (ticketMode === 'untrusted') {
            return Response.json({
              ticket: 'ht_evil',
              handoffUrl: 'https://evil.example.com/steal',
              expiresAt: '2026-11-24T12:01:00.000Z',
            });
          }
          return Response.json({
            ticket: 'ht_valid_123',
            handoffUrl: `${AMR_API_URL}/api/auth/one-tap/handoff?ticket=ht_valid_123`,
            expiresAt: '2026-11-24T12:01:00.000Z',
          });
        }
        return new Response('Not Found', { status: 404 });
      }) as typeof fetch,
    });

    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache, amrIdentity }));

    // 1. Unauthenticated -> 401
    const unauth = await app.request('/auth/upgrade-handoff');
    assert.equal(unauth.status, 401);

    // 2. Non-session PAT Bearer -> 403
    const pat = await createPat(store, {
      userId: projected.user.id,
      workspaceId: projected.workspace.id,
      role: 'owner',
      scopes: ['workspace:admin'],
      authMode: 'oidc',
      authMethod: 'session_cookie',
    }, { name: 'CI' });
    const patRes = await app.request('/auth/upgrade-handoff', {
      headers: { Authorization: `Bearer ${pat.token}` },
    });
    assert.equal(patRes.status, 403);

    // 3. Authenticated browser session -> 302 to AMR handoffUrl with attribution preserved in targetPath
    const okRes = await app.request(
      '/auth/upgrade-handoff?billing=plan&od_origin=openmotion&od_entry_source=openmotion_manage_subscription&od_entry_id=1234',
      { headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } },
    );
    assert.equal(okRes.status, 302);
    assert.equal(okRes.headers.get('location'), `${AMR_API_URL}/api/auth/one-tap/handoff?ticket=ht_valid_123`);
    const ticketBody = capturedTicketBodies.at(-1);
    assert.equal(ticketBody?.authUserId, 'ba_usr_upgrade');
    assert.equal(ticketBody?.appUserId, 'usr_app_upgrade');
    assert.match(
      String(ticketBody?.targetPath),
      /^\/pricing\?.*od_entry_source=openmotion_manage_subscription/,
    );

    // 4. AMR handoff-ticket unavailable -> 302 fallback to configured OPENDESIGN_PRICING_URL with attribution
    ticketMode = 'unavailable';
    const fallbackRes = await app.request(
      '/auth/upgrade-handoff?od_origin=openmotion&od_entry_source=openmotion_manage_subscription',
      { headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } },
    );
    assert.equal(fallbackRes.status, 302);
    const fallbackLoc = new URL(fallbackRes.headers.get('location')!);
    assert.equal(fallbackLoc.origin + fallbackLoc.pathname, 'https://open-design.ai/pricing');
    assert.equal(fallbackLoc.searchParams.get('od_entry_source'), 'openmotion_manage_subscription');

    // 5. Untrusted handoffUrl -> rejected and degraded to OPENDESIGN_PRICING_URL
    ticketMode = 'untrusted';
    const untrustedRes = await app.request('/auth/upgrade-handoff', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
    });
    assert.equal(untrustedRes.status, 302);
    assert.equal(untrustedRes.headers.get('location'), 'https://open-design.ai/pricing');
  });
});
