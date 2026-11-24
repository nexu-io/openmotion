import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import {
  AmrIdentityClient,
  InMemoryAuthCache,
  InMemoryAuthStore,
  OIDC_TX_COOKIE_NAME,
  ONETAP_CTX_COOKIE_NAME,
  OidcService,
  SESSION_COOKIE_NAME,
  TRACKING_ATTESTATION_COOKIE_NAME,
  createAuthMiddleware,
  createAuthRoutes,
  createBrowserSession,
  createPat,
  oneTapChallengeCookieName,
  type AuthEnv,
} from '../../src/auth/index.ts';
import {
  createApiApp,
  createCloudPosthogDispatcher,
  type ApiEventBusPort,
  type ApiQueuesPort,
} from '../../src/entrypoints/api.ts';
import { parseConfig, type AppConfig } from '../../src/infra/config.ts';
import { createAccountRoutes } from '../../src/routes/account.ts';
import { MockModelGateway } from '../../src/services/mock-model-adapter.ts';
import type { StoragePort } from '../../src/contracts/storage.ts';
import type { Database } from '../../src/db/client.ts';

const PUBLIC_ORIGIN = 'https://motion.open-design.ai';
const AMR_API_URL = 'https://amr-api.open-design.ai';
const AMR_INTERNAL_ONE_TAP_URL = 'http://amr-api.internal.svc.cluster.local:8080';
const INTERNAL_TOKEN = 'test-internal-s2s-token';
const ONE_TAP_INTERNAL_TOKEN = 'test-dedicated-onetap-s2s-token';

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
    OPENDESIGN_ONE_TAP_INTERNAL_URL: AMR_INTERNAL_ONE_TAP_URL,
    OPENDESIGN_ONE_TAP_INTERNAL_TOKEN: ONE_TAP_INTERNAL_TOKEN,
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
      oneTapApiUrl: AMR_INTERNAL_ONE_TAP_URL,
      oneTapInternalToken: ONE_TAP_INTERNAL_TOKEN,
      cache,
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        amrRequests.push({ url, method, headers, body });

        assert.equal(headers.get('authorization'), null);

        if (url === `${AMR_INTERNAL_ONE_TAP_URL}/api/internal/auth/one-tap/challenge` && method === 'POST') {
          assert.equal(headers.get('x-internal-token'), ONE_TAP_INTERNAL_TOKEN);
          const req = body as Record<string, unknown>;
          savedBindingHash = String(req.browserBindingHash);
          return Response.json({
            challengeId: 'otc_motion_123',
            nonce: 'nonce_abc_xyz',
            clientId: 'google-client-id.apps.googleusercontent.com',
            expiresAt: '2026-11-24T12:00:00.000Z',
          });
        }

        if (url === `${AMR_INTERNAL_ONE_TAP_URL}/api/internal/auth/one-tap/exchange` && method === 'POST') {
          assert.equal(headers.get('x-internal-token'), ONE_TAP_INTERNAL_TOKEN);
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
            odEntry: {
              sourceProduct: 'open_design',
              entryId: 'entry-1',
              sourceDetail: 'openmotion_manage_subscription',
              entryOccurredAt: '2026-11-24T01:00:00.000Z',
              campaignId: 'black_friday_2026',
              placementId: 'header_banner',
              conversionSource: 'pricing_cta',
            },
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
          assert.equal(headers.get('x-internal-token'), INTERNAL_TOKEN);
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
    const expectedCookieName = oneTapChallengeCookieName('otc_motion_123');
    const ctxHeader = challengeCookies.find((h) => h.startsWith(`${expectedCookieName}=`))!;
    assert.ok(ctxHeader, 'Expected per-challenge om_onetap_ctx_* cookie');
    assert.ok(ctxHeader.includes('HttpOnly'));
    assert.ok(ctxHeader.includes('SameSite=Lax'));
    assert.ok(ctxHeader.includes('Path=/auth'));
    assert.ok(ctxHeader.includes('Secure'));
    const ctxToken = extractCookieValue(challengeCookies, expectedCookieName)!;
    assert.equal(sha256Hex(ctxToken), savedBindingHash);

    // 3. Exchange rejects missing binding cookie
    const missingCookieRes = await app.request('/auth/one-tap', {
      method: 'POST',
      headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: 'otc_motion_123', idToken: 'google.id.token.jwt' }),
    });
    assert.equal(missingCookieRes.status, 400);
    assert.equal(((await missingCookieRes.json()) as { code: string }).code, 'CHALLENGE_INVALID');

    // 4. Valid exchange issues om_session, clears per-challenge cookie, and forwards full odEntry contract
    const exchangeRes = await app.request('/auth/one-tap', {
      method: 'POST',
      headers: {
        Origin: PUBLIC_ORIGIN,
        'content-type': 'application/json',
        Cookie: `${expectedCookieName}=${ctxToken}`,
      },
      body: JSON.stringify({
        challengeId: 'otc_motion_123',
        idToken: 'google.id.token.jwt',
        referralCode: 'REF42',
        attribution: {
          utmSource: 'twitter',
          utmCampaign: 'opengame_launch',
          landingPath: '/templates',
          odEntry: {
            sourceProduct: 'open_design',
            entryId: 'entry-1',
            sourceDetail: 'openmotion_manage_subscription',
            entryOccurredAt: '2026-11-24T01:00:00.000Z',
            campaignId: 'black_friday_2026',
            placementId: 'header_banner',
            conversionSource: 'pricing_cta',
            odDeviceId: 'should-be-stripped-without-consent',
            evilKey: 'should-be-stripped',
          },
        },
      }),
    });
    assert.equal(exchangeRes.status, 200);
    const exchangeCookies = exchangeRes.headers.getSetCookie();
    const sessionToken = extractCookieValue(exchangeCookies, SESSION_COOKIE_NAME)!;
    assert.ok(sessionToken && sessionToken.length >= 32);
    const clearedCtx = exchangeCookies.find((h) => h.startsWith(`${expectedCookieName}=`))!;
    assert.ok(clearedCtx.includes('Max-Age=0'), 'Expected per-challenge om_onetap_ctx_* to be cleared');

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
        oneTapApiUrl: AMR_INTERNAL_ONE_TAP_URL,
        oneTapInternalToken: ONE_TAP_INTERNAL_TOKEN,
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
    await cache.set(`om:amr:session-proof:${session.tokenHash}`, 'otsp_upgrade_proof_1', 3600);

    let ticketMode: 'ok' | 'untrusted' | 'unavailable' = 'ok';
    const capturedTicketBodies: Array<Record<string, unknown>> = [];

    const amrIdentity = new AmrIdentityClient({
      apiUrl: AMR_API_URL,
      internalToken: INTERNAL_TOKEN,
      oneTapApiUrl: AMR_INTERNAL_ONE_TAP_URL,
      oneTapInternalToken: ONE_TAP_INTERNAL_TOKEN,
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
        if (url === `${AMR_INTERNAL_ONE_TAP_URL}/api/internal/auth/one-tap/handoff-ticket`) {
          const headers = new Headers(init?.headers);
          assert.equal(headers.get('x-internal-token'), ONE_TAP_INTERNAL_TOKEN);
          const parsedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          assert.equal(parsedBody.sessionProof, 'otsp_upgrade_proof_1');
          capturedTicketBodies.push(parsedBody);
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

    // 1. Unauthenticated non-public target -> 401; guest public Pricing -> 302 to site root /pricing or /zh/pricing
    const unauth = await app.request('/auth/upgrade-handoff');
    assert.equal(unauth.status, 401);

    const guestEnPricing = await app.request(
      '/auth/upgrade-handoff?targetPath=%2Fpricing&od_origin=openmotion&od_entry_source=openmotion_manage_subscription&od_entry_id=guest-1',
    );
    assert.equal(guestEnPricing.status, 302);
    const guestEnDest = new URL(guestEnPricing.headers.get('location')!);
    assert.equal(guestEnDest.origin, 'https://open-design.ai');
    assert.equal(guestEnDest.pathname, '/pricing');
    assert.equal(guestEnDest.searchParams.get('od_entry_id'), 'guest-1');

    const guestZhPricing = await app.request(
      '/auth/upgrade-handoff?targetPath=%2Fzh%2Fpricing&od_origin=openmotion&od_entry_source=openmotion_manage_subscription&od_entry_id=guest-zh-1',
    );
    assert.equal(guestZhPricing.status, 302);
    const guestZhDest = new URL(guestZhPricing.headers.get('location')!);
    assert.equal(guestZhDest.origin, 'https://open-design.ai');
    assert.equal(guestZhDest.pathname, '/zh/pricing');
    assert.equal(guestZhDest.searchParams.get('od_entry_id'), 'guest-zh-1');

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
      /^\/dashboard\?.*od_entry_source=openmotion_manage_subscription/,
    );

    // 3b. Authenticated header Pricing (/pricing and /zh/pricing) mints account-bound handoff tickets with aligned targets
    const okZhPricing = await app.request(
      '/auth/upgrade-handoff?targetPath=%2Fzh%2Fpricing&od_origin=openmotion&od_entry_source=openmotion_manage_subscription&utm_medium=header',
      { headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } },
    );
    assert.equal(okZhPricing.status, 302);
    assert.equal(okZhPricing.headers.get('location'), `${AMR_API_URL}/api/auth/one-tap/handoff?ticket=ht_valid_123`);
    assert.match(String(capturedTicketBodies.at(-1)?.targetPath), /^\/zh\/pricing\?.*utm_medium=header/);

    // 4. AMR handoff-ticket unavailable -> 503 retryable HTML (never redirects to unbound Pricing!)
    ticketMode = 'unavailable';
    const fallbackRes = await app.request(
      '/auth/upgrade-handoff?od_origin=openmotion&od_entry_source=openmotion_manage_subscription',
      { headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` } },
    );
    assert.equal(fallbackRes.status, 503);
    assert.equal(fallbackRes.headers.get('location'), null);
    assert.match(await fallbackRes.text(), /Unable to verify billing handoff/);

    // 5. Untrusted handoffUrl -> rejected with 503 retryable HTML
    ticketMode = 'untrusted';
    const untrustedRes = await app.request('/auth/upgrade-handoff', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
    });
    assert.equal(untrustedRes.status, 503);
    assert.equal(untrustedRes.headers.get('location'), null);
  });

  it('preserves parallel challenges across tabs and invalidates om_onetap_ctx on /auth/logout', async () => {
    const config = makeConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();

    const issuedChallenges = new Map<string, string>();
    let seq = 0;

    const amrIdentity = new AmrIdentityClient({
      apiUrl: AMR_API_URL,
      internalToken: INTERNAL_TOKEN,
      oneTapApiUrl: AMR_INTERNAL_ONE_TAP_URL,
      oneTapInternalToken: ONE_TAP_INTERNAL_TOKEN,
      cache,
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (url === `${AMR_INTERNAL_ONE_TAP_URL}/api/internal/auth/one-tap/challenge`) {
          const id = `otc_tab_${++seq}`;
          issuedChallenges.set(id, String(body.browserBindingHash));
          return Response.json({
            challengeId: id,
            nonce: `nonce_${seq}`,
            clientId: 'gid-parallel',
            expiresAt: '2026-11-24T12:00:00.000Z',
          });
        }
        if (url === `${AMR_INTERNAL_ONE_TAP_URL}/api/internal/auth/one-tap/exchange`) {
          const expectedHash = issuedChallenges.get(String(body.challengeId));
          if (!expectedHash || expectedHash !== String(body.browserBindingHash)) {
            return Response.json({ code: 'CHALLENGE_INVALID', message: 'Binding mismatch' }, { status: 400 });
          }
          if (body.idToken === 'bad_token') {
            return Response.json({ code: 'INVALID_ID_TOKEN', message: 'Bad token' }, { status: 400 });
          }
          return Response.json({
            ok: true,
            authUserId: 'ba_tab',
            appUserId: 'usr_tab',
            email: 'tab@example.com',
            name: 'Tab User',
            image: null,
            isNewUser: false,
            planTier: 'free',
          });
        }
        if (url.startsWith(`${AMR_API_URL}/api/internal/identity/ba_tab`)) {
          return Response.json({
            active: true,
            status: 'active',
            authUserId: 'ba_tab',
            appUserId: 'usr_tab',
            email: 'tab@example.com',
            name: 'Tab User',
            image: null,
            workspace: {
              workspaceId: 'ws_tab',
              workspaceName: 'Tab WS',
              workspaceType: 'personal',
              workspaceMemberId: 'wm_tab',
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
    app.route('/', createAuthRoutes({ config, store, cache, amrIdentity }));

    // Two cookieless tabs issue POST /auth/one-tap/challenge concurrently before either receives Set-Cookie
    const [tab1ChallengeRes, tab2ChallengeRes] = await Promise.all([
      app.request('/auth/one-tap/challenge', {
        method: 'POST',
        headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'tab-1' }),
      }),
      app.request('/auth/one-tap/challenge', {
        method: 'POST',
        headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'tab-2' }),
      }),
    ]);
    assert.equal(tab1ChallengeRes.status, 200);
    assert.equal(tab2ChallengeRes.status, 200);
    const tab1Challenge = (await tab1ChallengeRes.json()) as { challengeId: string };
    const tab2Challenge = (await tab2ChallengeRes.json()) as { challengeId: string };
    const tab1CookieName = oneTapChallengeCookieName(tab1Challenge.challengeId);
    const tab2CookieName = oneTapChallengeCookieName(tab2Challenge.challengeId);
    assert.notEqual(tab1CookieName, tab2CookieName, 'Each concurrent challenge must use an isolated cookie');
    const tab1CtxToken = extractCookieValue(tab1ChallengeRes.headers.getSetCookie(), tab1CookieName)!;
    const tab2CtxToken = extractCookieValue(tab2ChallengeRes.headers.getSetCookie(), tab2CookieName)!;
    assert.ok(tab1CtxToken && tab2CtxToken);

    // Combined browser cookie jar holds BOTH cookies even when responses arrive interleaved (tab2 then tab1)
    const sharedJarCookie = `${tab2CookieName}=${tab2CtxToken}; ${tab1CookieName}=${tab1CtxToken}`;

    // Tab 2 fails with invalid token -> does NOT clobber Tab 1's isolated cookie
    const tab2Fail = await app.request('/auth/one-tap', {
      method: 'POST',
      headers: {
        Origin: PUBLIC_ORIGIN,
        'content-type': 'application/json',
        Cookie: sharedJarCookie,
      },
      body: JSON.stringify({ challengeId: tab2Challenge.challengeId, idToken: 'bad_token' }),
    });
    assert.equal(tab2Fail.status, 400);

    // Tab 1 still succeeds with challenge 1 from the shared jar
    const tab1Ok = await app.request('/auth/one-tap', {
      method: 'POST',
      headers: {
        Origin: PUBLIC_ORIGIN,
        'content-type': 'application/json',
        Cookie: sharedJarCookie,
      },
      body: JSON.stringify({ challengeId: tab1Challenge.challengeId, idToken: 'good_token' }),
    });
    assert.equal(tab1Ok.status, 200);
    const sessionToken = extractCookieValue(tab1Ok.headers.getSetCookie(), SESSION_COOKIE_NAME)!;

    // Logout clears om_session and every om_onetap_ctx* cookie
    const logoutRes = await app.request('/auth/logout', {
      method: 'POST',
      headers: {
        Origin: PUBLIC_ORIGIN,
        Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${tab2CookieName}=${tab2CtxToken}`,
      },
    });
    assert.equal(logoutRes.status, 200);
    const logoutCookies = logoutRes.headers.getSetCookie();
    assert.ok(logoutCookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && c.includes('Max-Age=0')));
    assert.ok(logoutCookies.some((c) => c.startsWith(`${tab2CookieName}=`) && c.includes('Max-Age=0')));
    assert.ok(logoutCookies.some((c) => c.startsWith(`${ONETAP_CTX_COOKIE_NAME}=`) && c.includes('Max-Age=0')));
  });

  it('maps authoritative AMR membershipTier: null to free and forwards app_user_id in PostHog sender', async () => {
    const freeClient = new AmrIdentityClient({
      apiUrl: AMR_API_URL,
      internalToken: INTERNAL_TOKEN,
      fetcher: (async () => Response.json({ membershipTier: null })) as typeof fetch,
    });
    assert.equal(await freeClient.lookupBillingPlanTier('usr_free_1'), 'free');

    const unknownClient = new AmrIdentityClient({
      apiUrl: AMR_API_URL,
      internalToken: INTERNAL_TOKEN,
      fetcher: (async () => new Response('Unavailable', { status: 503 })) as typeof fetch,
    });
    assert.equal(await unknownClient.lookupBillingPlanTier('usr_free_1'), 'unknown');

    const { createPosthogSender } = await import('../../tracking/node.ts');
    const capturedBatches: Array<{ batch: Array<{ properties: Record<string, unknown> }> }> = [];
    const sender = createPosthogSender({
      host: 'https://us.i.posthog.com',
      token: 'phc_test_token',
      identity: { installation_id: '00000000-0000-4000-8000-000000000099', utm_source: null, created_at: new Date().toISOString() },
      appVersion: '0.1.0',
      env: 'test',
      fetch: (async (_url, init) => {
        capturedBatches.push(JSON.parse(String(init?.body)));
        return Response.json({ status: 1 });
      }) as typeof fetch,
    });

    const receipt = await sender(
      [
        {
          event: 'onetap_login_success',
          event_id: '00000000-0000-4000-8000-000000000010',
          occurred_at: new Date().toISOString(),
          entrypoint: 'studio',
          device_timezone: 'UTC',
          utc_offset_minutes: 0,
          properties: {
            surface: 'motion_web',
            attempt_id: 'att-1',
            is_new_user: true,
            plan_tier: 'free',
            post_login_action: 'in_place',
          },
          app_user_id: 'usr_app_merged',
        },
      ],
      new AbortController().signal,
    );
    assert.equal(receipt, 'accepted');
    assert.equal(capturedBatches[0].batch[0].properties.distinct_id, 'usr_app_merged');
    assert.equal(capturedBatches[0].batch[0].properties.app_user_id, 'usr_app_merged');
    assert.equal(capturedBatches[0].batch[0].properties.$process_person_profile, true);
  });

  it('rejects One Tap S2S when dedicated internal URL or token is missing (never falls back to public API) and enforces K8s deployment config', async () => {
    let fetchCalls = 0;
    const countingFetch = (async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    }) as typeof fetch;

    const cases = [
      { label: 'missing both', oneTapApiUrl: undefined, oneTapInternalToken: undefined },
      { label: 'missing token only', oneTapApiUrl: AMR_INTERNAL_ONE_TAP_URL, oneTapInternalToken: undefined },
      { label: 'missing url only', oneTapApiUrl: undefined, oneTapInternalToken: ONE_TAP_INTERNAL_TOKEN },
    ];

    for (const tc of cases) {
      const client = new AmrIdentityClient({
        apiUrl: AMR_API_URL,
        internalToken: INTERNAL_TOKEN,
        oneTapApiUrl: tc.oneTapApiUrl,
        oneTapInternalToken: tc.oneTapInternalToken,
        fetcher: countingFetch,
      });
      assert.equal(client.isOneTapConfigured(), false, tc.label);
      await assert.rejects(
        () =>
          client.requestOneTapChallenge({
            expectedOrigin: PUBLIC_ORIGIN,
            surface: 'motion_web',
            attemptId: 'att-fail',
            browserBindingHash: sha256Hex('tok'),
          }),
        (err: unknown) => (err as { status?: number; code?: string }).status === 503 && (err as { code?: string }).code === 'ONE_TAP_UNAVAILABLE',
        `challenge should fail closed for ${tc.label}`,
      );
      await assert.rejects(
        () =>
          client.exchangeOneTapCredential({
            challengeId: 'otc_x',
            idToken: 'jwt_x',
            expectedOrigin: PUBLIC_ORIGIN,
            surface: 'motion_web',
            browserBindingHash: sha256Hex('tok'),
          }),
        (err: unknown) => (err as { status?: number; code?: string }).status === 503 && (err as { code?: string }).code === 'ONE_TAP_UNAVAILABLE',
        `exchange should fail closed for ${tc.label}`,
      );
      await assert.rejects(
        () =>
          client.createOneTapHandoffTicket({
            authUserId: 'ba_1',
            appUserId: 'usr_1',
            sessionProof: 'otsp_test_unconfigured',
            targetPath: '/pricing',
          }),
        (err: unknown) => (err as { status?: number; code?: string }).status === 503 && (err as { code?: string }).code === 'ONE_TAP_UNAVAILABLE',
        `handoff-ticket should fail closed for ${tc.label}`,
      );
    }
    assert.equal(fetchCalls, 0, 'Must never call public OPENDESIGN_API_URL when dedicated One Tap S2S config is incomplete');

    // Verify K8s manifests explicitly wire non-empty internal URL and non-optional token/URL refs
    const configmap = await readFile(path.resolve('deploy/k8s/configmap.yaml'), 'utf8');
    const deployment = await readFile(path.resolve('deploy/k8s/api-deployment.yaml'), 'utf8');
    assert.match(configmap, /OPENDESIGN_ONE_TAP_INTERNAL_URL:\s*"https?:\/\/[^"]+"/);
    assert.match(
      deployment,
      /- name: OPENDESIGN_ONE_TAP_INTERNAL_URL\s+valueFrom:\s+configMapKeyRef:\s+name: openmotion-config\s+key: OPENDESIGN_ONE_TAP_INTERNAL_URL\s+- name: OPENDESIGN_ONE_TAP_INTERNAL_TOKEN\s+valueFrom:\s+secretKeyRef:\s+name: openmotion-secrets\s+key: OPENDESIGN_ONE_TAP_INTERNAL_TOKEN\s+- name:/,
    );
  });

  it('blocks an in-flight One Tap exchange from issuing om_session when another tab completes /auth/logout', async () => {
    const config = makeConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();

    let releaseExchange!: () => void;
    let exchangeStartedResolve!: () => void;
    let blockNextExchange = false;
    let challengeSeq = 0;

    const amrIdentity = new AmrIdentityClient({
      apiUrl: AMR_API_URL,
      internalToken: INTERNAL_TOKEN,
      oneTapApiUrl: AMR_INTERNAL_ONE_TAP_URL,
      oneTapInternalToken: ONE_TAP_INTERNAL_TOKEN,
      cache,
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (url === `${AMR_INTERNAL_ONE_TAP_URL}/api/internal/auth/one-tap/challenge`) {
          challengeSeq += 1;
          return Response.json({
            challengeId: `otc_inflight_${challengeSeq}`,
            nonce: `nonce_${challengeSeq}`,
            clientId: 'gid-inflight',
            expiresAt: '2026-11-24T12:00:00.000Z',
          });
        }
        if (url === `${AMR_INTERNAL_ONE_TAP_URL}/api/internal/auth/one-tap/exchange`) {
          if (blockNextExchange) {
            blockNextExchange = false;
            exchangeStartedResolve();
            await new Promise<void>((resolve) => {
              releaseExchange = resolve;
            });
          }
          // Verify consented odDeviceId + odDeviceIdConsent passthrough on second login too
          if (body.challengeId === 'otc_inflight_2') {
            assert.deepEqual((body.attribution as { odEntry?: unknown })?.odEntry, {
              sourceProduct: 'open_design',
              entryId: 'ent_after_logout',
              sourceDetail: 'openmotion_manage_subscription',
              entryOccurredAt: '2026-11-24T02:00:00.000Z',
              campaignId: 'camp_1',
              placementId: 'place_1',
              conversionSource: 'banner',
              odDeviceId: 'dev_consented_99',
              odDeviceIdConsent: true,
            });
          }
          return Response.json({
            ok: true,
            authUserId: 'ba_race_u1',
            appUserId: 'usr_race_u1',
            email: 'race@example.com',
            name: 'Race User',
            image: null,
            isNewUser: false,
            planTier: 'free',
          });
        }
        if (url.startsWith(`${AMR_API_URL}/api/internal/identity/ba_race_u1`)) {
          return Response.json({
            active: true,
            status: 'active',
            authUserId: 'ba_race_u1',
            appUserId: 'usr_race_u1',
            email: 'race@example.com',
            name: 'Race User',
            image: null,
            workspace: {
              workspaceId: 'ws_race_u1',
              workspaceName: 'Race WS',
              workspaceType: 'personal',
              workspaceMemberId: 'wm_race',
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
    app.route('/', createAuthRoutes({ config, store, cache, amrIdentity }));

    // Seed an existing session in Tab 2 so Tab 2 can log out while Tab 1's One Tap exchange is in-flight
    const projected = await store.projectAmrUserAndWorkspace({
      oidcSub: 'ba_race_u1',
      appUserId: 'usr_race_u1',
      email: 'race@example.com',
      displayName: 'Race User',
      avatarUrl: null,
      externalWorkspaceId: 'ws_race_u1',
      workspaceName: 'Race WS',
      role: 'owner',
    });
    const existingSession = await createBrowserSession(store, {
      userId: projected.user.id,
      workspaceId: projected.workspace.id,
    });

    // Tab 1 acquires challenge 1
    const c1Res = await app.request('/auth/one-tap/challenge', {
      method: 'POST',
      headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'att-race-1' }),
    });
    assert.equal(c1Res.status, 200);
    const c1Body = (await c1Res.json()) as { challengeId: string };
    const c1CookieName = oneTapChallengeCookieName(c1Body.challengeId);
    const c1Token = extractCookieValue(c1Res.headers.getSetCookie(), c1CookieName)!;

    // Start Tab 1's exchange and pause it while waiting on AMR S2S
    blockNextExchange = true;
    const exchangeStarted = new Promise<void>((resolve) => {
      exchangeStartedResolve = resolve;
    });
    const inFlightExchangePromise = app.request('/auth/one-tap', {
      method: 'POST',
      headers: {
        Origin: PUBLIC_ORIGIN,
        'content-type': 'application/json',
        Cookie: `${c1CookieName}=${c1Token}`,
      },
      body: JSON.stringify({ challengeId: c1Body.challengeId, idToken: 'jwt_slow_1' }),
    });

    await exchangeStarted;

    // Tab 2 completes /auth/logout while Tab 1's exchange is still in-flight
    const logoutRes = await app.request('/auth/logout', {
      method: 'POST',
      headers: {
        Origin: PUBLIC_ORIGIN,
        Cookie: `${SESSION_COOKIE_NAME}=${existingSession.token}; ${c1CookieName}=${c1Token}`,
      },
    });
    assert.equal(logoutRes.status, 200);

    // Release slow AMR S2S response -> Tab 1 MUST be rejected and MUST NOT mint om_session
    releaseExchange();
    const inFlightRes = await inFlightExchangePromise;
    assert.equal(inFlightRes.status, 409);
    assert.equal(((await inFlightRes.json()) as { code: string }).code, 'CHALLENGE_INVALID');
    const inFlightCookies = inFlightRes.headers.getSetCookie();
    assert.equal(
      extractCookieValue(inFlightCookies, SESSION_COOKIE_NAME),
      null,
      'Revoked in-flight exchange must NEVER issue om_session',
    );

    // A brand-new One Tap challenge started AFTER logout succeeds normally (and preserves consented odDeviceId)
    const c2Res = await app.request('/auth/one-tap/challenge', {
      method: 'POST',
      headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'att-race-2' }),
    });
    const c2Body = (await c2Res.json()) as { challengeId: string };
    const c2CookieName = oneTapChallengeCookieName(c2Body.challengeId);
    const c2Token = extractCookieValue(c2Res.headers.getSetCookie(), c2CookieName)!;

    const c2ExchangeRes = await app.request('/auth/one-tap', {
      method: 'POST',
      headers: {
        Origin: PUBLIC_ORIGIN,
        'content-type': 'application/json',
        Cookie: `${c2CookieName}=${c2Token}; om_metrics_consent=granted`,
      },
      body: JSON.stringify({
        challengeId: c2Body.challengeId,
        idToken: 'jwt_fresh_2',
        attribution: {
          odEntry: {
            sourceProduct: 'open_design',
            entryId: 'ent_after_logout',
            sourceDetail: 'openmotion_manage_subscription',
            entryOccurredAt: '2026-11-24T02:00:00.000Z',
            campaignId: 'camp_1',
            placementId: 'place_1',
            conversionSource: 'banner',
            odDeviceId: 'dev_consented_99',
            odDeviceIdConsent: true,
          },
        },
      }),
    });
    assert.equal(c2ExchangeRes.status, 200);
    assert.ok(extractCookieValue(c2ExchangeRes.headers.getSetCookie(), SESSION_COOKIE_NAME));
  });

  it('delivers od_onetap_suppress=1 via OIDC id_token_hint + post_logout_redirect_uri instead of bare end_session_endpoint', async () => {
    const config = makeConfig({
      OIDC_POST_LOGOUT_REDIRECT_URI: 'https://open-design.ai/cloud/login',
    });
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();

    let issuedIdToken = '';
    const oidc = new OidcService(
      {
        issuer: 'https://amr-api.open-design.ai/oauth',
        clientId: 'openmotion-cloud-client',
        clientSecret: 'ephemeral-test-client-secret',
        callbackUrl: `${PUBLIC_ORIGIN}/auth/callback`,
        scopes: 'openid profile email',
        claimSub: 'sub',
        claimEmail: 'email',
        claimName: 'name',
        discovery: {
          issuer: 'https://amr-api.open-design.ai/oauth',
          authorization_endpoint: 'https://amr-api.open-design.ai/oauth/authorize',
          token_endpoint: 'https://amr-api.open-design.ai/oauth/token',
          end_session_endpoint: 'https://amr-api.open-design.ai/oauth/end-session',
          id_token_signing_alg_values_supported: ['HS256'],
        },
        fetcher: (async () => {
          return Response.json({ id_token: issuedIdToken, access_token: 'at_1' });
        }) as typeof fetch,
      },
      cache,
    );

    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache, oidc }));

    // 1. Complete OIDC login so server persists id_token for RP-Initiated Logout
    const loginRes = await app.request('/auth/login?returnTo=/');
    assert.equal(loginRes.status, 302);
    const authUrl = new URL(loginRes.headers.get('location')!);
    const state = authUrl.searchParams.get('state')!;
    const nonce = authUrl.searchParams.get('nonce')!;
    const txCookie = extractCookieValue(loginRes.headers.getSetCookie(), OIDC_TX_COOKIE_NAME)!;

    issuedIdToken = await new SignJWT({
      sub: 'ba_logout_oidc',
      email: 'oidc@example.com',
      name: 'OIDC User',
      nonce,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('https://amr-api.open-design.ai/oauth')
      .setAudience('openmotion-cloud-client')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('ephemeral-test-client-secret'));

    const cbRes = await app.request(
      `/auth/callback?code=code_logout_1&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `${OIDC_TX_COOKIE_NAME}=${txCookie}` } },
    );
    assert.equal(cbRes.status, 302);
    const oidcSessionToken = extractCookieValue(cbRes.headers.getSetCookie(), SESSION_COOKIE_NAME)!;

    // 2. Logout returns end_session_endpoint with BOTH id_token_hint AND post_logout_redirect_uri carrying od_onetap_suppress=1
    const logoutRes = await app.request('/auth/logout', {
      method: 'POST',
      headers: {
        Origin: PUBLIC_ORIGIN,
        Cookie: `${SESSION_COOKIE_NAME}=${oidcSessionToken}`,
      },
    });
    assert.equal(logoutRes.status, 200);
    const logoutPayload = (await logoutRes.json()) as { ok: boolean; endSessionUrl?: string };
    assert.equal(logoutPayload.ok, true);
    assert.ok(logoutPayload.endSessionUrl);
    const endUrl = new URL(logoutPayload.endSessionUrl!);
    assert.equal(endUrl.origin + endUrl.pathname, 'https://amr-api.open-design.ai/oauth/end-session');
    assert.equal(endUrl.searchParams.get('id_token_hint'), issuedIdToken);
    assert.equal(endUrl.searchParams.get('od_onetap_suppress'), null, 'Must not blindly append od_onetap_suppress to bare end_session_endpoint');
    const postLogoutUri = new URL(endUrl.searchParams.get('post_logout_redirect_uri')!);
    assert.equal(postLogoutUri.origin + postLogoutUri.pathname, 'https://open-design.ai/cloud/login');
    assert.equal(postLogoutUri.searchParams.get('od_onetap_suppress'), '1');

    // 3. Session created without OIDC id_token (e.g. One Tap) does NOT call bare end_session_endpoint
    const noIdTokenConfig = makeConfig();
    const noLandingApp = new Hono<AuthEnv>();
    noLandingApp.route('/', createAuthRoutes({ config: noIdTokenConfig, store, cache, oidc }));
    const seeded = store.seedWorkspace({ role: 'owner', displayName: 'OneTap User' });
    const oneTapSession = await createBrowserSession(store, {
      userId: seeded.user.id,
      workspaceId: seeded.workspace.id,
    });
    const oneTapLogout = await noLandingApp.request('/auth/logout', {
      method: 'POST',
      headers: {
        Origin: PUBLIC_ORIGIN,
        Cookie: `${SESSION_COOKIE_NAME}=${oneTapSession.token}`,
      },
    });
    assert.equal(oneTapLogout.status, 200);
    const oneTapPayload = (await oneTapLogout.json()) as { ok: boolean; endSessionUrl?: string };
    assert.equal(oneTapPayload.endSessionUrl, undefined);
  });

  it('delivers cloud tracking batches via createCloudPosthogDispatcher and preserves per-event attribution across guest->login, A->B switch, and logout->re-login', async () => {
    const config = makeConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();

    const posthogBatches: Array<{
      batch: Array<{ event: string; uuid: string; properties: Record<string, unknown> }>;
    }> = [];
    const onTrackingEvents = createCloudPosthogDispatcher({
      config,
      host: 'https://us.i.posthog.com',
      token: 'phc_cloud_test_token',
      fetch: (async (_url, init) => {
        posthogBatches.push(JSON.parse(String(init?.body)));
        return Response.json({ status: 1 });
      }) as typeof fetch,
    });

    const amrUsers: Record<string, { authUserId: string; appUserId: string; wsId: string; email: string }> = {
      tok_A: { authUserId: 'ba_uA', appUserId: 'usr_app_A', wsId: 'ws_uA', email: 'a@example.com' },
      tok_B: { authUserId: 'ba_uB', appUserId: 'usr_app_B', wsId: 'ws_uB', email: 'b@example.com' },
    };
    let seq = 0;

    const amrIdentity = new AmrIdentityClient({
      apiUrl: AMR_API_URL,
      internalToken: INTERNAL_TOKEN,
      oneTapApiUrl: AMR_INTERNAL_ONE_TAP_URL,
      oneTapInternalToken: ONE_TAP_INTERNAL_TOKEN,
      cache,
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (url === `${AMR_INTERNAL_ONE_TAP_URL}/api/internal/auth/one-tap/challenge`) {
          return Response.json({
            challengeId: `otc_trk_${++seq}`,
            nonce: `nonce_${seq}`,
            clientId: 'gid-trk',
            expiresAt: '2026-11-24T12:00:00.000Z',
          });
        }
        if (url === `${AMR_INTERNAL_ONE_TAP_URL}/api/internal/auth/one-tap/exchange`) {
          const u = amrUsers[String(body.idToken)];
          return Response.json({
            ok: true,
            authUserId: u.authUserId,
            appUserId: u.appUserId,
            email: u.email,
            name: u.email,
            image: null,
            isNewUser: false,
            planTier: 'free',
          });
        }
        for (const u of Object.values(amrUsers)) {
          if (url.startsWith(`${AMR_API_URL}/api/internal/identity/${u.authUserId}`)) {
            return Response.json({
              active: true,
              status: 'active',
              authUserId: u.authUserId,
              appUserId: u.appUserId,
              email: u.email,
              name: u.email,
              image: null,
              workspace: {
                workspaceId: u.wsId,
                workspaceName: 'WS',
                workspaceType: 'personal',
                workspaceMemberId: `wm_${u.appUserId}`,
                role: 'owner',
                lifecycleState: 'active',
                effectiveWriteAccess: 'writable',
              },
            });
          }
        }
        return new Response('Not Found', { status: 404 });
      }) as typeof fetch,
    });

    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-cloud-track-'));
    try {
      await mkdir(path.join(tmpRoot, 'studio/build'), { recursive: true });
      await writeFile(
        path.join(tmpRoot, 'studio/build/index.html'),
        '<!doctype html><html><head><title>Studio</title></head><body></body></html>',
      );

      const { app } = createApiApp({
        config,
        db: {} as Database,
        storage: {} as StoragePort,
        queues: {} as ApiQueuesPort,
        eventBus: {} as ApiEventBusPort,
        authStore: store,
        authCache: cache,
        amrIdentity,
        gateway: new MockModelGateway(),
        onTrackingEvents,
        runtimeRoot: tmpRoot,
      });

      const makeEvent = (
        event: string,
        properties: Record<string, unknown>,
        appUserId?: string,
      ) => ({
        event,
        event_id: crypto.randomUUID(),
        occurred_at: new Date().toISOString(),
        entrypoint: 'studio',
        device_timezone: 'UTC',
        utc_offset_minutes: 0,
        properties,
        ...(appUserId ? { app_user_id: appUserId } : {}),
      });

      const loginOneTap = async (idToken: 'tok_A' | 'tok_B', existingTrackAtt?: string) => {
        const cRes = await app.request('/auth/one-tap/challenge', {
          method: 'POST',
          headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ attemptId: `att-${idToken}` }),
        });
        const cBody = (await cRes.json()) as { challengeId: string };
        const cName = oneTapChallengeCookieName(cBody.challengeId);
        const cTok = extractCookieValue(cRes.headers.getSetCookie(), cName)!;
        const cookieParts = [`${cName}=${cTok}`];
        if (existingTrackAtt) cookieParts.push(`${TRACKING_ATTESTATION_COOKIE_NAME}=${existingTrackAtt}`);
        const exRes = await app.request('/auth/one-tap', {
          method: 'POST',
          headers: {
            Origin: PUBLIC_ORIGIN,
            'content-type': 'application/json',
            Cookie: cookieParts.join('; '),
          },
          body: JSON.stringify({ challengeId: cBody.challengeId, idToken }),
        });
        assert.equal(exRes.status, 200);
        const cookies = exRes.headers.getSetCookie();
        return {
          session: extractCookieValue(cookies, SESSION_COOKIE_NAME)!,
          trackAtt: extractCookieValue(cookies, TRACKING_ATTESTATION_COOKIE_NAME)!,
        };
      };

      // Sequence 1: Guest -> One Tap Login as A (mixed batch flushed after login)
      const sessionA = await loginOneTap('tok_A');
      assert.ok(sessionA.trackAtt, 'Expected signed tracking attestation cookie on login');
      const seq1Res = await app.request('/motion-api/tracking', {
        method: 'POST',
        headers: {
          Origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
          Cookie: `${SESSION_COOKIE_NAME}=${sessionA.session}; ${TRACKING_ATTESTATION_COOKIE_NAME}=${sessionA.trackAtt}`,
        },
        body: JSON.stringify({
          events: [
            makeEvent('onetap_prompt_attempt', {
              surface: 'motion_web',
              attempt_id: 'att-g1',
              device_type: 'desktop',
              suppressed: false,
            }),
            makeEvent(
              'onetap_login_success',
              {
                surface: 'motion_web',
                attempt_id: 'att-g1',
                is_new_user: false,
                plan_tier: 'free',
                post_login_action: 'in_place',
              },
              'usr_app_A',
            ),
          ],
        }),
      });
      assert.equal(seq1Res.status, 202);
      const batch1 = posthogBatches.at(-1)!.batch;
      assert.equal(batch1.length, 2);
      assert.equal(batch1[0].event, 'onetap_prompt_attempt');
      assert.equal(batch1[0].properties.app_user_id, undefined, 'Guest pre-login event must stay anonymous');
      assert.equal(batch1[0].properties.$process_person_profile, false);
      assert.equal(batch1[1].event, 'onetap_login_success');
      assert.equal(batch1[1].properties.distinct_id, 'usr_app_A');
      assert.equal(batch1[1].properties.app_user_id, 'usr_app_A');
      assert.equal(batch1[1].properties.$process_person_profile, true);

      // Sequence 2: Switch Account A -> Account B; A's queued event + B's event + spoofed victim event flushed under B's cookie
      const sessionB = await loginOneTap('tok_B', sessionA.trackAtt);
      const seq2Res = await app.request('/motion-api/tracking', {
        method: 'POST',
        headers: {
          Origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
          Cookie: `${SESSION_COOKIE_NAME}=${sessionB.session}; ${TRACKING_ATTESTATION_COOKIE_NAME}=${sessionB.trackAtt}`,
        },
        body: JSON.stringify({
          events: [
            makeEvent('ui_click', { page_name: 'studio', area: 'workspace', element: 'new_creation' }, 'usr_app_A'),
            makeEvent('ui_click', { page_name: 'studio', area: 'workspace', element: 'new_creation' }, 'usr_app_B'),
            makeEvent('ui_click', { page_name: 'studio', area: 'workspace', element: 'new_creation' }, 'usr_spoofed_victim'),
          ],
        }),
      });
      assert.equal(seq2Res.status, 202);
      const batch2 = posthogBatches.at(-1)!.batch;
      assert.equal(batch2.length, 2, 'Spoofed non-attested ui_click must be rejected');
      assert.equal(batch2[0].properties.distinct_id, 'usr_app_A', 'Queued Account A event must retain A attribution under B cookie');
      assert.equal(batch2[1].properties.distinct_id, 'usr_app_B');

      // Sequence 3: Account B logs out -> B's queued event flushed AFTER logout (no om_session) -> guest prompt -> re-login as A
      const logoutRes = await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          Origin: PUBLIC_ORIGIN,
          Cookie: `${SESSION_COOKIE_NAME}=${sessionB.session}`,
        },
      });
      assert.equal(logoutRes.status, 200);

      const seq3AfterLogout = await app.request('/motion-api/tracking', {
        method: 'POST',
        headers: {
          Origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
          Cookie: `${TRACKING_ATTESTATION_COOKIE_NAME}=${sessionB.trackAtt}`,
        },
        body: JSON.stringify({
          events: [
            makeEvent('ui_click', { page_name: 'studio', area: 'workspace', element: 'new_creation' }, 'usr_app_B'),
            makeEvent('onetap_prompt_attempt', {
              surface: 'motion_web',
              attempt_id: 'att-after-logout',
              device_type: 'desktop',
              suppressed: true,
            }),
          ],
        }),
      });
      assert.equal(seq3AfterLogout.status, 202);
      const batch3 = posthogBatches.at(-1)!.batch;
      assert.equal(batch3.length, 2);
      assert.equal(batch3[0].properties.distinct_id, 'usr_app_B', 'Account B event flushed after logout must preserve B attribution');
      assert.equal(batch3[1].properties.app_user_id, undefined);
      assert.equal(batch3[1].properties.$process_person_profile, false);

      const reloginA = await loginOneTap('tok_A', sessionB.trackAtt);
      const seq3Relogin = await app.request('/motion-api/tracking', {
        method: 'POST',
        headers: {
          Origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
          Cookie: `${SESSION_COOKIE_NAME}=${reloginA.session}; ${TRACKING_ATTESTATION_COOKIE_NAME}=${reloginA.trackAtt}`,
        },
        body: JSON.stringify({
          events: [
            makeEvent(
              'onetap_login_success',
              {
                surface: 'motion_web',
                attempt_id: 'att-relogin',
                is_new_user: false,
                plan_tier: 'free',
                post_login_action: 'in_place',
              },
              'usr_app_A',
            ),
          ],
        }),
      });
      assert.equal(seq3Relogin.status, 202);
      assert.equal(posthogBatches.at(-1)!.batch[0].properties.distinct_id, 'usr_app_A');

      // Item 13: Verify Studio main HTML document emits Google GIS CSP, Permissions-Policy, and compatible COOP
      const htmlRes = await app.request('/');
      assert.equal(htmlRes.status, 200);
      const csp = htmlRes.headers.get('content-security-policy') ?? '';
      assert.match(csp, /script-src[^;]*https:\/\/accounts\.google\.com\/gsi\/client/);
      assert.match(csp, /style-src[^;]*https:\/\/accounts\.google\.com\/gsi\/style/);
      assert.match(csp, /frame-src[^;]*https:\/\/accounts\.google\.com\/gsi\//);
      assert.match(csp, /connect-src[^;]*https:\/\/accounts\.google\.com\/gsi\//);
      assert.match(csp, /connect-src[^;]*http:\/\/127\.0\.0\.1:\*/);
      assert.match(csp, /connect-src[^;]*http:\/\/localhost:\*/);
      assert.equal(
        htmlRes.headers.get('permissions-policy'),
        'identity-credentials-get=(self "https://accounts.google.com")',
      );
      assert.equal(htmlRes.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
      assert.notEqual(htmlRes.headers.get('cross-origin-opener-policy'), 'same-origin');

      const ingressYaml = await readFile(path.resolve('deploy/k8s/ingress.yaml'), 'utf8');
      assert.match(ingressYaml, /accounts\.google\.com\/gsi/);
      assert.match(ingressYaml, /http:\/\/127\.0\.0\.1:\*/);
      assert.match(ingressYaml, /identity-credentials-get=\(self "https:\/\/accounts\.google\.com"\)/);
      assert.match(ingressYaml, /Cross-Origin-Opener-Policy:\s*same-origin-allow-popups/);
      assert.doesNotMatch(ingressYaml, /Cross-Origin-Opener-Policy:\s*same-origin["';\s]*$/m);

      // K8s ConfigMap & NetworkPolicy alignment for internal AMR One Tap service (port 18080)
      const configMapYaml = await readFile(path.resolve('deploy/k8s/configmap.yaml'), 'utf8');
      assert.match(configMapYaml, /OPENDESIGN_ONE_TAP_INTERNAL_URL:\s*"http:\/\/amr-api\.amr\.svc\.cluster\.local:18080"/);
      const netPolYaml = await readFile(path.resolve('deploy/k8s/networkpolicy.yaml'), 'utf8');
      assert.match(netPolYaml, /kubernetes\.io\/metadata\.name:\s*amr[\s\S]*?port:\s*18080/);

      // /motion-api/tracking consent gate: default false, explicit consent cookie enables deviceIdConsented=true
      const defaultTrackCfg = await app.request('/motion-api/tracking');
      assert.equal(defaultTrackCfg.status, 200);
      assert.equal(((await defaultTrackCfg.json()) as { deviceIdConsented?: boolean }).deviceIdConsented, false);

      const grantConsentRes = await app.request('/motion-api/tracking/consent', {
        method: 'POST',
        headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ deviceIdConsented: true }),
      });
      assert.equal(grantConsentRes.status, 200);
      const consentCookie = extractCookieValue(grantConsentRes.headers.getSetCookie(), 'om_metrics_consent');
      assert.equal(consentCookie, 'granted');
      const consentedTrackCfg = await app.request('/motion-api/tracking', {
        headers: { Cookie: `om_metrics_consent=${consentCookie}` },
      });
      assert.equal(((await consentedTrackCfg.json()) as { deviceIdConsented?: boolean }).deviceIdConsented, true);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('preserves event utm_source in PostHog payload, returns retryable 503 on PostHog outage, and revokes session if logout races createSession commit', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-onetap-r3-'));
    try {
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();
      const config = makeConfig();
      let posthogFailOnce = true;
      const outboundBatches: Array<{ batch: Array<{ event: string; properties: Record<string, unknown> }> }> = [];

      const onTrackingEvents = createCloudPosthogDispatcher({
        config,
        host: 'https://us.i.posthog.com',
        token: 'phc_test_r3_token_12345',
        fetch: (async (_url, init) => {
          if (posthogFailOnce) {
            posthogFailOnce = false;
            return new Response('rate limited', { status: 429 });
          }
          outboundBatches.push(JSON.parse(String(init?.body)));
          return Response.json({ status: 1 });
        }) as typeof fetch,
      });

      const amrIdentity = new AmrIdentityClient({
        apiUrl: AMR_API_URL,
        internalToken: INTERNAL_TOKEN,
        oneTapApiUrl: AMR_INTERNAL_ONE_TAP_URL,
        oneTapInternalToken: ONE_TAP_INTERNAL_TOKEN,
        cache,
        fetcher: (async (input) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          if (url === `${AMR_INTERNAL_ONE_TAP_URL}/api/internal/auth/one-tap/challenge`) {
            return Response.json({
              challengeId: 'otc_r3_race',
              nonce: 'nonce_r3_race',
              clientId: 'gid-r3',
              expiresAt: '2026-11-24T12:00:00.000Z',
            });
          }
          if (url === `${AMR_INTERNAL_ONE_TAP_URL}/api/internal/auth/one-tap/exchange`) {
            return Response.json({
              ok: true,
              authUserId: 'auth_r3_u',
              appUserId: 'usr_r3_u',
              email: 'r3@example.com',
              name: 'R3 User',
              image: null,
              isNewUser: false,
              planTier: 'free',
            });
          }
          if (url.startsWith(`${AMR_API_URL}/api/internal/identity/auth_r3_u`)) {
            return Response.json({
              active: true,
              status: 'active',
              authUserId: 'auth_r3_u',
              appUserId: 'usr_r3_u',
              email: 'r3@example.com',
              name: 'R3 User',
              image: null,
              workspace: {
                workspaceId: 'ws_r3',
                workspaceName: 'WS R3',
                workspaceType: 'personal',
                workspaceMemberId: 'wm_r3',
                role: 'owner',
                lifecycleState: 'active',
                effectiveWriteAccess: 'writable',
              },
            });
          }
          throw new Error(`Unexpected AMR fetch: ${url}`);
        }) as typeof fetch,
      });

      // Intercept createSession to inject a concurrent /auth/logout AFTER pre-insert checks pass
      // and BEFORE createSession resolves!
      let triggerLogoutDuringCommit: (() => Promise<void>) | null = null;
      const originalCreateSession = store.createSession.bind(store);
      store.createSession = async (input) => {
        const created = await originalCreateSession(input);
        if (triggerLogoutDuringCommit) {
          const fn = triggerLogoutDuringCommit;
          triggerLogoutDuringCommit = null;
          await fn();
        }
        return created;
      };

      const { app } = createApiApp({
        config,
        db: {} as Database,
        storage: {} as StoragePort,
        queues: {} as ApiQueuesPort,
        eventBus: {} as ApiEventBusPort,
        authStore: store,
        authCache: cache,
        amrIdentity,
        gateway: new MockModelGateway(),
        onTrackingEvents,
        runtimeRoot: tmpRoot,
      });

      // 1. PostHog 429 must return retryable 503 (never silent 202), and retry preserves event utm_source
      const makeUtmEvent = () => ({
        event: 'onetap_login_success',
        event_id: crypto.randomUUID(),
        occurred_at: new Date().toISOString(),
        entrypoint: 'studio',
        device_timezone: 'UTC',
        utc_offset_minutes: 0,
        properties: {
          surface: 'motion_web',
          attempt_id: 'att-utm-1',
          is_new_user: false,
          plan_tier: 'free',
          post_login_action: 'in_place',
          utm_source: 'x_launch',
        },
      });
      const firstAttempt = await app.request('/motion-api/tracking', {
        method: 'POST',
        headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ events: [makeUtmEvent()] }),
      });
      assert.equal(firstAttempt.status, 503);
      assert.equal(((await firstAttempt.json()) as { retryable?: boolean }).retryable, true);

      const secondAttempt = await app.request('/motion-api/tracking', {
        method: 'POST',
        headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ events: [makeUtmEvent()] }),
      });
      assert.equal(secondAttempt.status, 202);
      assert.equal(outboundBatches.length, 1);
      assert.equal(outboundBatches[0].batch[0].properties.utm_source, 'x_launch');
      assert.equal(outboundBatches[0].batch[0].properties.od_utm_source, 'x_launch');

      // 2. Concurrent logout racing DURING createSession commit must revoke the newly created session and return 409
      const cRes = await app.request('/auth/one-tap/challenge', {
        method: 'POST',
        headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'att-commit-race' }),
      });
      const cBody = (await cRes.json()) as { challengeId: string };
      const cName = oneTapChallengeCookieName(cBody.challengeId);
      const cTok = extractCookieValue(cRes.headers.getSetCookie(), cName)!;

      triggerLogoutDuringCommit = async () => {
        const lRes = await app.request('/auth/logout', {
          method: 'POST',
          headers: {
            Origin: PUBLIC_ORIGIN,
            Cookie: `${cName}=${cTok}`,
          },
        });
        assert.equal(lRes.status, 200);
      };

      const raceRes = await app.request('/auth/one-tap', {
        method: 'POST',
        headers: {
          Origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
          Cookie: `${cName}=${cTok}`,
        },
        body: JSON.stringify({ challengeId: cBody.challengeId, idToken: 'tok_race' }),
      });
      assert.equal(raceRes.status, 409);
      const raceCookies = raceRes.headers.getSetCookie();
      assert.equal(extractCookieValue(raceCookies, SESSION_COOKIE_NAME), null, 'No om_session cookie may be emitted');
      // Verify all sessions created in store were revoked
      const activeSessions = [...store.sessions.values()].filter((s) => s.revokedAt === null);
      assert.equal(activeSessions.length, 0, 'Newly created session must be revoked when logout raced commit');

      // 3. Logout racing DURING saveSessionProof (cache.set) must ALSO revoke session + delete proof + return 409
      const cProofRes = await app.request('/auth/one-tap/challenge', {
        method: 'POST',
        headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'att-proof-race' }),
      });
      const cProofBody = (await cProofRes.json()) as { challengeId: string };
      const cProofName = oneTapChallengeCookieName(cProofBody.challengeId);
      const cProofTok = extractCookieValue(cProofRes.headers.getSetCookie(), cProofName)!;

      // Return sessionProof from AMR and trigger logout right while cache.set persists sessionProof
      const originalCacheSet = cache.set.bind(cache);
      let proofRaceTriggered = false;
      cache.set = async (key, value, ttlSec) => {
        await originalCacheSet(key, value, ttlSec);
        if (!proofRaceTriggered && key.startsWith('om:amr:session-proof:')) {
          proofRaceTriggered = true;
          const lRes = await app.request('/auth/logout', {
            method: 'POST',
            headers: { Origin: PUBLIC_ORIGIN, Cookie: `${cProofName}=${cProofTok}` },
          });
          assert.equal(lRes.status, 200);
        }
      };

      const amrWithProof = new AmrIdentityClient({
        apiUrl: AMR_API_URL,
        internalToken: INTERNAL_TOKEN,
        oneTapApiUrl: AMR_INTERNAL_ONE_TAP_URL,
        oneTapInternalToken: ONE_TAP_INTERNAL_TOKEN,
        cache,
        fetcher: (async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          if (url === `${AMR_INTERNAL_ONE_TAP_URL}/api/internal/auth/one-tap/challenge`) {
            return Response.json({
              challengeId: 'otc_r4_proof_race',
              nonce: 'nonce_r4',
              clientId: 'gid-r4',
              expiresAt: '2026-11-24T12:00:00.000Z',
            });
          }
          if (url === `${AMR_INTERNAL_ONE_TAP_URL}/api/internal/auth/one-tap/exchange`) {
            const parsed = JSON.parse(String(init?.body ?? '{}')) as { attribution?: { odEntry?: Record<string, unknown> } };
            // Without om_metrics_consent=granted cookie, odDeviceId must be stripped even if client claims consent
            assert.equal(parsed.attribution?.odEntry?.odDeviceId, undefined);
            assert.equal(parsed.attribution?.odEntry?.odDeviceIdConsent, undefined);
            return Response.json({
              ok: true,
              authUserId: 'auth_r3_u',
              appUserId: 'usr_r3_u',
              email: 'r3@example.com',
              name: 'R3 User',
              image: null,
              isNewUser: false,
              planTier: 'free',
              sessionProof: 'otsp_r4_proof_race',
            });
          }
          if (url.startsWith(`${AMR_API_URL}/api/internal/identity/auth_r3_u`)) {
            return Response.json({
              active: true,
              status: 'active',
              authUserId: 'auth_r3_u',
              appUserId: 'usr_r3_u',
              email: 'r3@example.com',
              name: 'R3 User',
              image: null,
              workspace: {
                workspaceId: 'ws_r3',
                workspaceName: 'WS R3',
                workspaceType: 'personal',
                workspaceMemberId: 'wm_r3',
                role: 'owner',
                lifecycleState: 'active',
                effectiveWriteAccess: 'writable',
              },
            });
          }
          throw new Error(`Unexpected AMR fetch: ${url}`);
        }) as typeof fetch,
      });

      const { app: appProofRace } = createApiApp({
        config,
        db: {} as Database,
        storage: {} as StoragePort,
        queues: {} as ApiQueuesPort,
        eventBus: {} as ApiEventBusPort,
        authStore: store,
        authCache: cache,
        amrIdentity: amrWithProof,
        gateway: new MockModelGateway(),
        onTrackingEvents,
        runtimeRoot: tmpRoot,
      });

      const c4Res = await appProofRace.request('/auth/one-tap/challenge', {
        method: 'POST',
        headers: { Origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'att-r4' }),
      });
      const c4Body = (await c4Res.json()) as { challengeId: string };
      const c4Name = oneTapChallengeCookieName(c4Body.challengeId);
      const c4Tok = extractCookieValue(c4Res.headers.getSetCookie(), c4Name)!;

      // Wire logout during saveSessionProof to use c4Name/c4Tok
      cache.set = async (key, value, ttlSec) => {
        await originalCacheSet(key, value, ttlSec);
        if (key.startsWith('om:amr:session-proof:')) {
          const lRes = await appProofRace.request('/auth/logout', {
            method: 'POST',
            headers: { Origin: PUBLIC_ORIGIN, Cookie: `${c4Name}=${c4Tok}` },
          });
          assert.equal(lRes.status, 200);
        }
      };

      const proofRaceRes = await appProofRace.request('/auth/one-tap', {
        method: 'POST',
        headers: {
          Origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
          Cookie: `${c4Name}=${c4Tok}; om_metrics_consent=denied`,
        },
        body: JSON.stringify({
          challengeId: c4Body.challengeId,
          idToken: 'tok_r4',
          attribution: {
            odEntry: {
              sourceProduct: 'open_design',
              entryId: 'ent_denied',
              sourceDetail: 'openmotion_manage_subscription',
              entryOccurredAt: '2026-11-24T02:00:00.000Z',
              odDeviceId: 'dev_spoofed_without_cookie',
              odDeviceIdConsent: true,
            },
          },
        }),
      });
      assert.equal(proofRaceRes.status, 409);
      assert.equal(extractCookieValue(proofRaceRes.headers.getSetCookie(), SESSION_COOKIE_NAME), null);
      assert.equal([...store.sessions.values()].filter((s) => s.revokedAt === null).length, 0);

      // 4. GET /auth/upgrade-handoff with om_session cookie when store/cache throws DB error MUST fail closed (503, NO Location)
      const originalFindSession = store.findActiveSessionByTokenHash.bind(store);
      store.findActiveSessionByTokenHash = async () => {
        throw new Error('simulated postgres connection error');
      };
      const dbErrRes = await appProofRace.request('/auth/upgrade-handoff?targetPath=%2Fpricing', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=some_valid_length_session_token_0123456789` },
      });
      store.findActiveSessionByTokenHash = originalFindSession;
      assert.equal(dbErrRes.status, 503);
      assert.equal(dbErrRes.headers.get('location'), null);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
