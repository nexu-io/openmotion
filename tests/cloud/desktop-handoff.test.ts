import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import {
  DESKTOP_HANDOFF_EXCHANGE_PATH,
  DESKTOP_HANDOFF_START_PATH,
  DESKTOP_HANDOFF_TTL_SEC,
  type DesktopHandoffExchangeResponse,
} from '../../shared/desktop-auth-handoff.ts';
import {
  createDesktopHandoffRoutes,
  DesktopOidcProvenanceStore,
} from '../../src/auth/desktop-handoff.ts';
import {
  AmrIdentityClient,
  DESKTOP_OIDC_CTX_COOKIE_NAME,
  InMemoryAuthCache,
  InMemoryAuthStore,
  OIDC_TX_COOKIE_NAME,
  OidcService,
  SESSION_COOKIE_NAME,
  assertSafeReturnTo,
  createAuthRoutes,
  createBrowserSession,
  generatePkcePair,
  revokeBrowserSession,
  type AuthEnv,
} from '../../src/auth/index.ts';
import { parseConfig, type AppConfig } from '../../src/infra/config.ts';

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

function extractCookieValue(setCookieHeaders: string[], name: string): string | null {
  for (const header of setCookieHeaders) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(header.trim());
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

function buildStartUrl(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, v);
  }
  return `${DESKTOP_HANDOFF_START_PATH}?${qs.toString()}`;
}

describe('Desktop System-Browser Session Handoff API', () => {
  describe('GET /auth/desktop/start parameter validation', () => {
    it('rejects missing or invalid PKCE, state, and non-loopback redirect_uri with 400 INVALID_REQUEST', async () => {
      const config = makeConfig();
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();
      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store, cache }));

      const { codeChallenge } = generatePkcePair();
      const validRedirect = 'http://127.0.0.1:45123/auth/callback';

      const invalidCases: Array<{ label: string; params: Record<string, string | undefined> }> = [
        {
          label: 'missing code_challenge',
          params: { code_challenge_method: 'S256', redirect_uri: validRedirect, state: 'st-1' },
        },
        {
          label: 'too short code_challenge',
          params: {
            code_challenge: 'short',
            code_challenge_method: 'S256',
            redirect_uri: validRedirect,
            state: 'st-1',
          },
        },
        {
          label: 'non-base64url code_challenge',
          params: {
            code_challenge: 'a'.repeat(42) + '+',
            code_challenge_method: 'S256',
            redirect_uri: validRedirect,
            state: 'st-1',
          },
        },
        {
          label: 'plain code_challenge_method',
          params: {
            code_challenge: codeChallenge,
            code_challenge_method: 'plain',
            redirect_uri: validRedirect,
            state: 'st-1',
          },
        },
        {
          label: 'missing code_challenge_method',
          params: {
            code_challenge: codeChallenge,
            redirect_uri: validRedirect,
            state: 'st-1',
          },
        },
        {
          label: 'missing state',
          params: {
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: validRedirect,
          },
        },
        {
          label: 'empty state',
          params: {
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: validRedirect,
            state: '   ',
          },
        },
        {
          label: 'state exceeding 256 chars',
          params: {
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: validRedirect,
            state: 's'.repeat(257),
          },
        },
        {
          label: 'remote https redirect_uri',
          params: {
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: 'https://evil.example.com/callback',
            state: 'st-1',
          },
        },
        {
          label: 'remote http redirect_uri',
          params: {
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: 'http://evil.example.com:45123/callback',
            state: 'st-1',
          },
        },
        {
          label: 'https loopback redirect_uri',
          params: {
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: 'https://127.0.0.1:45123/callback',
            state: 'st-1',
          },
        },
        {
          label: 'privileged port loopback redirect_uri',
          params: {
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: 'http://127.0.0.1:80/callback',
            state: 'st-1',
          },
        },
        {
          label: 'missing port loopback redirect_uri',
          params: {
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: 'http://localhost/callback',
            state: 'st-1',
          },
        },
        {
          label: 'loopback redirect_uri with fragment',
          params: {
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: 'http://127.0.0.1:45123/callback#frag',
            state: 'st-1',
          },
        },
        {
          label: 'loopback redirect_uri with credentials',
          params: {
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: 'http://user:pass@127.0.0.1:45123/callback',
            state: 'st-1',
          },
        },
      ];

      for (const tc of invalidCases) {
        const res = await app.request(buildStartUrl(tc.params));
        assert.equal(res.status, 400, `Expected 400 for case: ${tc.label}`);
        const body = (await res.json()) as { code: string; error: string };
        assert.equal(body.code, 'INVALID_REQUEST', `Expected INVALID_REQUEST for case: ${tc.label}`);
      }
    });
  });

  describe('GET /auth/desktop/start unauthenticated & switch=1 redirect', () => {
    it('redirects unauthenticated OIDC requests to /auth/login with safe returnTo', async () => {
      const config = makeConfig();
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();
      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store, cache }));

      const { codeChallenge } = generatePkcePair();
      const redirectUri = 'http://127.0.0.1:45123/callback';
      const state = 'desktop-state-123';

      const res = await app.request(
        buildStartUrl({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state,
        }),
      );
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('cache-control'), 'no-store');

      const location = res.headers.get('location')!;
      assert.ok(location.startsWith('/auth/login?'));
      const loginUrl = new URL(location, 'https://motion.example.test');
      assert.equal(loginUrl.pathname, '/auth/login');
      assert.equal(loginUrl.searchParams.get('switch'), null);

      const returnTo = loginUrl.searchParams.get('returnTo')!;
      assert.equal(assertSafeReturnTo(returnTo), returnTo);
      const parsedReturn = new URL(returnTo, 'https://motion.example.test');
      assert.equal(parsedReturn.pathname, DESKTOP_HANDOFF_START_PATH);
      assert.equal(parsedReturn.searchParams.get('code_challenge'), codeChallenge);
      assert.equal(parsedReturn.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(parsedReturn.searchParams.get('redirect_uri'), redirectUri);
      assert.equal(parsedReturn.searchParams.get('state'), state);
      assert.equal(parsedReturn.searchParams.get('interactive'), null);
    });

    it('forwards switch=1 to /auth/login?switch=1 and strips switch=1 from returnTo to prevent loops', async () => {
      const config = makeConfig();
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();
      const seeded = store.seedWorkspace({ email: 'alice@example.test', displayName: 'Alice' });
      const browserSession = await createBrowserSession(store, {
        userId: seeded.user.id,
        workspaceId: seeded.workspace.id,
      });

      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store, cache }));

      const { codeChallenge } = generatePkcePair();
      const redirectUri = 'http://127.0.0.1:45123/callback';
      const res = await app.request(
        buildStartUrl({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'switch-state',
          switch: '1',
        }),
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` } },
      );

      assert.equal(res.status, 302);
      const loginUrl = new URL(res.headers.get('location')!, 'https://motion.example.test');
      assert.equal(loginUrl.pathname, '/auth/login');
      assert.equal(loginUrl.searchParams.get('switch'), '1');

      const returnTo = loginUrl.searchParams.get('returnTo')!;
      assert.equal(assertSafeReturnTo(returnTo), returnTo);
      const parsedReturn = new URL(returnTo, 'https://motion.example.test');
      assert.equal(parsedReturn.pathname, DESKTOP_HANDOFF_START_PATH);
      assert.equal(parsedReturn.searchParams.get('switch'), null);
      assert.equal(parsedReturn.searchParams.get('state'), 'switch-state');
    });
  });

  describe('Happy path: start -> loopback redirect -> exchange -> independent desktop session', () => {
    it('mints one-time code, exchanges with PKCE S256, sets Secure HttpOnly om_session cookie, and isolates desktop session', async () => {
      const config = makeConfig({ APP_PUBLIC_ORIGIN: 'https://motion.example.test' });
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();
      const seeded = store.seedWorkspace({
        email: 'alice@example.test',
        displayName: 'Alice Desktop',
        role: 'owner',
      });
      const browserSession = await createBrowserSession(store, {
        userId: seeded.user.id,
        workspaceId: seeded.workspace.id,
      });

      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store, cache }));

      const { codeVerifier, codeChallenge } = generatePkcePair();
      const redirectUri = 'http://127.0.0.1:45123/desktop/cb?flow=login';
      const state = 'state-happy-path-1';

      // Step 1: Authenticated start redirects to loopback with code + state (preserving query params)
      const startRes = await app.request(
        buildStartUrl({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state,
        }),
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` } },
      );
      assert.equal(startRes.status, 302);
      assert.equal(startRes.headers.get('cache-control'), 'no-store');

      const loopbackUrl = new URL(startRes.headers.get('location')!);
      assert.equal(loopbackUrl.origin, 'http://127.0.0.1:45123');
      assert.equal(loopbackUrl.pathname, '/desktop/cb');
      assert.equal(loopbackUrl.searchParams.get('flow'), 'login');
      assert.equal(loopbackUrl.searchParams.get('state'), state);
      const code = loopbackUrl.searchParams.get('code')!;
      assert.ok(code && code.length >= 32);

      // Step 2: Desktop exchanges code + codeVerifier + redirectUri
      const exchangeRes = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier, redirectUri }),
      });
      assert.equal(exchangeRes.status, 200);
      assert.equal(exchangeRes.headers.get('cache-control'), 'no-store');

      const setCookies = exchangeRes.headers.getSetCookie();
      const sessionHeader = setCookies.find((h) => h.startsWith(`${SESSION_COOKIE_NAME}=`))!;
      assert.ok(sessionHeader, 'Expected Set-Cookie header for om_session');
      assert.ok(sessionHeader.includes('HttpOnly'));
      assert.ok(sessionHeader.includes('SameSite=Lax'));
      assert.ok(sessionHeader.includes('Path=/'));
      assert.ok(sessionHeader.includes('Secure'));

      const desktopToken = extractCookieValue(setCookies, SESSION_COOKIE_NAME)!;
      assert.ok(desktopToken.length >= 32);
      assert.notEqual(desktopToken, browserSession.token);

      const payload = (await exchangeRes.json()) as DesktopHandoffExchangeResponse;
      assert.deepEqual(payload, {
        ok: true,
        user: {
          id: seeded.user.id,
          email: 'alice@example.test',
          name: 'Alice Desktop',
        },
        workspaceId: seeded.workspace.id,
        planTier: 'unknown',
        interactiveLogin: false,
      });

      // Step 3: Desktop cookie works on /auth/me and stays valid even if browser session is revoked
      await revokeBrowserSession(store, { rawToken: browserSession.token }, cache);

      const browserMe = await app.request('/auth/me', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` },
      });
      assert.equal(browserMe.status, 401);

      const desktopMe = await app.request('/auth/me', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${desktopToken}` },
      });
      assert.equal(desktopMe.status, 200);
      const meBody = (await desktopMe.json()) as {
        user: { id: string; email: string };
        activeWorkspaceId: string;
      };
      assert.equal(meBody.user.id, seeded.user.id);
      assert.equal(meBody.activeWorkspaceId, seeded.workspace.id);
    });

    it('works in AUTH_MODE=dev and omits Secure cookie flag for http:// APP_PUBLIC_ORIGIN', async () => {
      const config = makeConfig({
        AUTH_MODE: 'dev',
        APP_PUBLIC_ORIGIN: 'http://127.0.0.1:4173',
      });
      const store = new InMemoryAuthStore();
      // Omit cache to exercise the in-memory Map fallback path as well.
      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store }));

      const { codeVerifier, codeChallenge } = generatePkcePair();
      const redirectUri = 'http://localhost:49001/cb';
      const startRes = await app.request(
        buildStartUrl({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'dev-state',
        }),
      );
      assert.equal(startRes.status, 302);
      const code = new URL(startRes.headers.get('location')!).searchParams.get('code')!;

      const exchangeRes = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier, redirectUri }),
      });
      assert.equal(exchangeRes.status, 200);
      const sessionHeader = exchangeRes.headers
        .getSetCookie()
        .find((h) => h.startsWith(`${SESSION_COOKIE_NAME}=`))!;
      assert.ok(sessionHeader.includes('HttpOnly'));
      assert.ok(sessionHeader.includes('SameSite=Lax'));
      assert.equal(sessionHeader.includes('Secure'), false);

      const body = (await exchangeRes.json()) as DesktopHandoffExchangeResponse;
      assert.equal(body.ok, true);
      assert.equal(body.user.id, config.DEV_USER_ID);
      assert.equal(body.workspaceId, config.DEV_WORKSPACE_ID);
    });

    it('supports IPv6 loopback redirect_uri ([::1])', async () => {
      const config = makeConfig({ AUTH_MODE: 'dev', APP_PUBLIC_ORIGIN: 'http://127.0.0.1:4173' });
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();
      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store, cache }));

      const { codeVerifier, codeChallenge } = generatePkcePair();
      const redirectUri = 'http://[::1]:45999/auth/handoff';
      const startRes = await app.request(
        buildStartUrl({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'ipv6-state',
        }),
      );
      assert.equal(startRes.status, 302);
      const code = new URL(startRes.headers.get('location')!).searchParams.get('code')!;

      const exchangeRes = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier, redirectUri }),
      });
      assert.equal(exchangeRes.status, 200);
    });
  });

  describe('Security invariants: single-use replay, TTL expiry, PKCE binding, redirectUri binding', () => {
    it('rejects single-use code replay (sequential and concurrent)', async () => {
      const config = makeConfig();
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();
      const seeded = store.seedWorkspace({ email: 'replay@example.test', displayName: 'Replay User' });
      const browserSession = await createBrowserSession(store, {
        userId: seeded.user.id,
        workspaceId: seeded.workspace.id,
      });

      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store, cache }));

      const { codeVerifier, codeChallenge } = generatePkcePair();
      const redirectUri = 'http://127.0.0.1:45124/cb';

      // Sequential replay
      const start1 = await app.request(
        buildStartUrl({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'replay-seq',
        }),
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` } },
      );
      const code1 = new URL(start1.headers.get('location')!).searchParams.get('code')!;

      const firstExchange = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code1, codeVerifier, redirectUri }),
      });
      assert.equal(firstExchange.status, 200);

      const secondExchange = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code1, codeVerifier, redirectUri }),
      });
      assert.equal(secondExchange.status, 401);
      assert.equal(((await secondExchange.json()) as { code: string }).code, 'UNAUTHORIZED');

      // Concurrent replay race: strictly one succeeds and one fails
      const start2 = await app.request(
        buildStartUrl({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'replay-concurrent',
        }),
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` } },
      );
      const code2 = new URL(start2.headers.get('location')!).searchParams.get('code')!;

      const [raceA, raceB] = await Promise.all([
        app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code2, codeVerifier, redirectUri }),
        }),
        app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code2, codeVerifier, redirectUri }),
        }),
      ]);
      assert.deepEqual([raceA.status, raceB.status].sort((a, b) => a - b), [200, 401]);
    });

    it('rejects expired codes (> 60s) with both cache and in-memory fallback', async () => {
      const config = makeConfig();
      const store = new InMemoryAuthStore();
      const seeded = store.seedWorkspace({ email: 'expiry@example.test', displayName: 'Expiry User' });
      const browserSession = await createBrowserSession(store, {
        userId: seeded.user.id,
        workspaceId: seeded.workspace.id,
      });

      const { codeVerifier, codeChallenge } = generatePkcePair();
      const redirectUri = 'http://127.0.0.1:45125/cb';

      // Case A: In-memory Map fallback with deterministic clock advance
      let nowMs = 1_700_000_000_000;
      const fallbackApp = createDesktopHandoffRoutes(
        { config, store },
        { now: () => nowMs },
      );

      const startFallback = await fallbackApp.request(
        buildStartUrl({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'exp-fallback',
        }),
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` } },
      );
      assert.equal(startFallback.status, 302);
      const fallbackCode = new URL(startFallback.headers.get('location')!).searchParams.get('code')!;

      nowMs += DESKTOP_HANDOFF_TTL_SEC * 1000 + 1;
      const expiredFallback = await fallbackApp.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: fallbackCode, codeVerifier, redirectUri }),
      });
      assert.equal(expiredFallback.status, 401);
      assert.equal(((await expiredFallback.json()) as { code: string }).code, 'UNAUTHORIZED');

      // Case B: Cache-backed (simulating cache that still holds value past expiresAt)
      const cache = new InMemoryAuthCache();
      let cacheClock = 1_700_000_000_000;
      const cachedApp = createDesktopHandoffRoutes(
        { config, store, cache },
        { now: () => cacheClock },
      );

      const startCached = await cachedApp.request(
        buildStartUrl({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'exp-cache',
        }),
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` } },
      );
      assert.equal(startCached.status, 302);
      const cachedCode = new URL(startCached.headers.get('location')!).searchParams.get('code')!;

      cacheClock += DESKTOP_HANDOFF_TTL_SEC * 1000 + 1000;
      const expiredCached = await cachedApp.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: cachedCode, codeVerifier, redirectUri }),
      });
      assert.equal(expiredCached.status, 401);
      assert.equal(((await expiredCached.json()) as { code: string }).code, 'UNAUTHORIZED');
    });

    it('rejects wrong PKCE verifier and burns the one-time code', async () => {
      const config = makeConfig();
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();
      const seeded = store.seedWorkspace({ email: 'pkce@example.test', displayName: 'PKCE User' });
      const browserSession = await createBrowserSession(store, {
        userId: seeded.user.id,
        workspaceId: seeded.workspace.id,
      });

      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store, cache }));

      const { codeVerifier, codeChallenge } = generatePkcePair();
      const wrongPair = generatePkcePair();
      const redirectUri = 'http://127.0.0.1:45126/cb';

      const startRes = await app.request(
        buildStartUrl({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'pkce-wrong',
        }),
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` } },
      );
      const code = new URL(startRes.headers.get('location')!).searchParams.get('code')!;

      const wrongRes = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier: wrongPair.codeVerifier, redirectUri }),
      });
      assert.equal(wrongRes.status, 401);
      assert.equal(((await wrongRes.json()) as { code: string }).code, 'UNAUTHORIZED');

      // Code was already consumed, so retrying with the real verifier must also fail
      const retryRes = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier, redirectUri }),
      });
      assert.equal(retryRes.status, 401);
    });

    it('rejects mismatched redirectUri and invalid exchange payloads', async () => {
      const config = makeConfig();
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();
      const seeded = store.seedWorkspace({ email: 'redir@example.test', displayName: 'Redirect User' });
      const browserSession = await createBrowserSession(store, {
        userId: seeded.user.id,
        workspaceId: seeded.workspace.id,
      });

      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store, cache }));

      const { codeVerifier, codeChallenge } = generatePkcePair();
      const redirectUri = 'http://127.0.0.1:45127/cb';

      // Invalid JSON body
      const badJson = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      });
      assert.equal(badJson.status, 400);
      assert.equal(((await badJson.json()) as { code: string }).code, 'INVALID_REQUEST');

      // Missing fields
      const missingField = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc', redirectUri }),
      });
      assert.equal(missingField.status, 400);
      assert.equal(((await missingField.json()) as { code: string }).code, 'INVALID_REQUEST');

      // Non-loopback redirectUri in exchange body
      const nonLoopback = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'abc',
          codeVerifier,
          redirectUri: 'https://evil.example.com/cb',
        }),
      });
      assert.equal(nonLoopback.status, 400);
      assert.equal(((await nonLoopback.json()) as { code: string }).code, 'INVALID_REQUEST');

      // Mismatched loopback redirectUri
      const startRes = await app.request(
        buildStartUrl({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'redir-mismatch',
        }),
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` } },
      );
      const code = new URL(startRes.headers.get('location')!).searchParams.get('code')!;

      const mismatchRes = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          codeVerifier,
          redirectUri: 'http://127.0.0.1:45128/cb',
        }),
      });
      assert.equal(mismatchRes.status, 400);
      assert.equal(((await mismatchRes.json()) as { code: string }).code, 'INVALID_REQUEST');

      // Code was burned by the mismatched attempt
      const retryRes = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier, redirectUri }),
      });
      assert.equal(retryRes.status, 401);
    });
  });

  describe('Authoritative planTier and OIDC-bound One Tap provenance propagation', () => {
    it('binds AMR id_token auth_method=google_one_tap strictly to the OIDC transaction + desktop PKCE and rejects spoofed query params or cross-flow replay', async () => {
      const oneTapInternalUrl = 'http://amr-api.internal.svc.cluster.local:8080';
      const oneTapInternalToken = 'dedicated-desktop-onetap-token';
      const config = makeConfig({
        OPENDESIGN_API_URL: 'https://amr-api.example.test',
        OPENDESIGN_INTERNAL_API_TOKEN: 's2s-token',
        OPENDESIGN_ONE_TAP_INTERNAL_URL: oneTapInternalUrl,
        OPENDESIGN_ONE_TAP_INTERNAL_TOKEN: oneTapInternalToken,
      });
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();

      let billingPlanResponse: { status: number; body: Record<string, unknown> } = {
        status: 200,
        body: { membershipTier: 'free' },
      };
      let nextIdTokenClaims: Record<string, unknown> = {};
      const capturedTicketTargets: string[] = [];

      const amrIdentity = new AmrIdentityClient({
        apiUrl: 'https://amr-api.example.test',
        internalToken: 's2s-token',
        oneTapApiUrl: oneTapInternalUrl,
        oneTapInternalToken,
        cache,
        fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.startsWith('https://amr-api.example.test/api/internal/identity/ba_usr_desktop')) {
            return Response.json({
              active: true,
              status: 'active',
              authUserId: 'ba_usr_desktop',
              appUserId: 'usr_app_desktop',
              email: 'desktop@example.test',
              name: 'Desktop User',
              image: null,
              workspace: {
                workspaceId: 'ws_amr_desktop',
                workspaceName: 'Desktop Workspace',
                workspaceType: 'personal',
                workspaceMemberId: 'wm_desktop',
                role: 'owner',
                lifecycleState: 'active',
                effectiveWriteAccess: 'writable',
              },
            });
          }
          if (url === 'https://amr-api.example.test/api/internal/billing/summary/usr_app_desktop') {
            return Response.json(billingPlanResponse.body, { status: billingPlanResponse.status });
          }
          if (url === `${oneTapInternalUrl}/api/internal/auth/one-tap/handoff-ticket`) {
            const headers = new Headers(init?.headers);
            assert.equal(headers.get('x-internal-token'), oneTapInternalToken);
            const body = JSON.parse(String(init?.body ?? '{}')) as { targetPath?: string; sessionProof?: string };
            assert.equal(body.sessionProof, 'otsp_desktop_proof_1');
            if (body.targetPath) capturedTicketTargets.push(body.targetPath);
            return Response.json({
              ticket: 'ht_desktop_1',
              handoffUrl: 'https://amr-api.example.test/api/auth/one-tap/handoff?ticket=ht_desktop_1',
              expiresAt: '2026-11-24T12:01:00.000Z',
            });
          }
          return new Response('Not Found', { status: 404 });
        }) as typeof fetch,
      });

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
            id_token_signing_alg_values_supported: ['HS256'],
          },
          fetcher: (async () => {
            const idToken = await new SignJWT({
              sub: 'ba_usr_desktop',
              email: 'desktop@example.test',
              name: 'Desktop User',
              ...nextIdTokenClaims,
            })
              .setProtectedHeader({ alg: 'HS256' })
              .setIssuer('https://idp.example.test')
              .setAudience('openmotion-cloud-client')
              .setIssuedAt()
              .setExpirationTime('10m')
              .sign(new TextEncoder().encode('ephemeral-test-client-secret'));
            return Response.json({ id_token: idToken, access_token: 'at_desktop' });
          }) as typeof fetch,
        },
        cache,
      );

      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store, cache, oidc, amrIdentity }));

      const redirectUri = 'http://127.0.0.1:45200/callback';

      // Helper running the real browser flow: /auth/desktop/start -> /auth/login -> /auth/callback -> /auth/desktop/start
      const runOidcDesktopFlow = async (claims: Record<string, unknown>, stateLabel: string) => {
        const pair = generatePkcePair();
        const start1 = await app.request(
          buildStartUrl({
            code_challenge: pair.codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: redirectUri,
            state: stateLabel,
          }),
        );
        assert.equal(start1.status, 302);
        const loginPath = start1.headers.get('location')!;
        assert.ok(loginPath.startsWith('/auth/login?'));

        const loginRes = await app.request(loginPath);
        assert.equal(loginRes.status, 302);
        const authUrl = new URL(loginRes.headers.get('location')!);
        const oidcState = authUrl.searchParams.get('state')!;
        const oidcNonce = authUrl.searchParams.get('nonce')!;
        const txCookie = extractCookieValue(loginRes.headers.getSetCookie(), OIDC_TX_COOKIE_NAME)!;

        nextIdTokenClaims = { nonce: oidcNonce, ...claims };
        const cbRes = await app.request(
          `/auth/callback?code=code_${stateLabel}&state=${encodeURIComponent(oidcState)}`,
          { headers: { Cookie: `${OIDC_TX_COOKIE_NAME}=${txCookie}` } },
        );
        assert.equal(cbRes.status, 302);
        const cbCookies = cbRes.headers.getSetCookie();
        const sessionToken = extractCookieValue(cbCookies, SESSION_COOKIE_NAME)!;
        const desktopOidcCtx = extractCookieValue(cbCookies, DESKTOP_OIDC_CTX_COOKIE_NAME)!;
        const returnTo = cbRes.headers.get('location')!;
        assert.ok(sessionToken && desktopOidcCtx);
        return { pair, sessionToken, desktopOidcCtx, returnTo };
      };

      // Case 1: Real AMR One Tap OIDC (auth_method: 'google_one_tap' + motion_session_proof) + membershipTier: null -> free + pricingHandoffUrl (/pricing)
      billingPlanResponse = { status: 200, body: { membershipTier: null } };
      const oneTapFlow = await runOidcDesktopFlow(
        { auth_method: 'google_one_tap', motion_session_proof: 'otsp_desktop_proof_1' },
        'real-onetap',
      );
      const startAfterOneTap = await app.request(oneTapFlow.returnTo, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${oneTapFlow.sessionToken}; ${DESKTOP_OIDC_CTX_COOKIE_NAME}=${oneTapFlow.desktopOidcCtx}`,
        },
      });
      assert.equal(startAfterOneTap.status, 302);
      const code1 = new URL(startAfterOneTap.headers.get('location')!).searchParams.get('code')!;
      const exchange1 = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code1, codeVerifier: oneTapFlow.pair.codeVerifier, redirectUri }),
      });
      assert.equal(exchange1.status, 200);
      const body1 = (await exchange1.json()) as DesktopHandoffExchangeResponse;
      assert.equal(body1.interactiveLogin, true);
      assert.equal(body1.oneTapVerified, true);
      assert.equal(body1.planTier, 'free');
      assert.equal(
        body1.pricingHandoffUrl,
        'https://amr-api.example.test/api/auth/one-tap/handoff?ticket=ht_desktop_1',
      );
      assert.equal(capturedTicketTargets.at(-1), '/pricing');

      // Case 2: Ordinary OIDC / silent AMR session reuse (no auth_method: 'google_one_tap') -> interactiveLogin: false, NO pricingHandoffUrl
      const ordinaryFlow = await runOidcDesktopFlow({ one_tap: true, amr: ['google_one_tap'] }, 'ordinary-oidc');
      const startAfterOrdinary = await app.request(ordinaryFlow.returnTo, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${ordinaryFlow.sessionToken}; ${DESKTOP_OIDC_CTX_COOKIE_NAME}=${ordinaryFlow.desktopOidcCtx}`,
        },
      });
      assert.equal(startAfterOrdinary.status, 302);
      const code2 = new URL(startAfterOrdinary.headers.get('location')!).searchParams.get('code')!;
      const exchange2 = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code2, codeVerifier: ordinaryFlow.pair.codeVerifier, redirectUri }),
      });
      assert.equal(exchange2.status, 200);
      const body2 = (await exchange2.json()) as DesktopHandoffExchangeResponse;
      assert.equal(body2.interactiveLogin, false);
      assert.equal(body2.oneTapVerified, undefined);
      assert.equal(body2.pricingHandoffUrl, undefined);

      // Case 3: Existing om_session fast-path + spoofed ?interactive=1&one_tap=1 WITHOUT valid context cookie -> MUST NOT trigger Pricing
      const spoofPair = generatePkcePair();
      const startSpoof = await app.request(
        buildStartUrl({
          code_challenge: spoofPair.codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'spoof-query',
          interactive: '1',
          one_tap: '1',
        }),
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${oneTapFlow.sessionToken}` } },
      );
      assert.equal(startSpoof.status, 302);
      const codeSpoof = new URL(startSpoof.headers.get('location')!).searchParams.get('code')!;
      const exchangeSpoof = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeSpoof, codeVerifier: spoofPair.codeVerifier, redirectUri }),
      });
      assert.equal(exchangeSpoof.status, 200);
      const spoofBody = (await exchangeSpoof.json()) as DesktopHandoffExchangeResponse;
      assert.equal(spoofBody.interactiveLogin, false);
      assert.equal(spoofBody.oneTapVerified, undefined);
      assert.equal(spoofBody.pricingHandoffUrl, undefined);

      // Case 4: Replaying a verified One Tap context cookie onto a DIFFERENT desktop PKCE transaction -> rejected (no Pricing)
      const flowA = await runOidcDesktopFlow({ auth_method: 'google_one_tap' }, 'flow-a');
      const otherPair = generatePkcePair();
      const replayStart = await app.request(
        buildStartUrl({
          code_challenge: otherPair.codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'flow-b',
        }),
        {
          headers: {
            Cookie: `${SESSION_COOKIE_NAME}=${flowA.sessionToken}; ${DESKTOP_OIDC_CTX_COOKIE_NAME}=${flowA.desktopOidcCtx}`,
          },
        },
      );
      assert.equal(replayStart.status, 302);
      const codeReplay = new URL(replayStart.headers.get('location')!).searchParams.get('code')!;
      const exchangeReplay = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeReplay, codeVerifier: otherPair.codeVerifier, redirectUri }),
      });
      assert.equal(exchangeReplay.status, 200);
      const replayBody = (await exchangeReplay.json()) as DesktopHandoffExchangeResponse;
      assert.equal(replayBody.interactiveLogin, false);
      assert.equal(replayBody.oneTapVerified, undefined);
      assert.equal(replayBody.pricingHandoffUrl, undefined);

      // Case 5: Billing lookup fails -> falls back to 'unknown' (never hardcoded 'free', no Pricing handoff ticket)
      billingPlanResponse = { status: 503, body: { error: 'billing_down' } };
      const unknownFlow = await runOidcDesktopFlow({ auth_method: 'google_one_tap' }, 'unknown-plan');
      const startUnknown = await app.request(unknownFlow.returnTo, {
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${unknownFlow.sessionToken}; ${DESKTOP_OIDC_CTX_COOKIE_NAME}=${unknownFlow.desktopOidcCtx}`,
        },
      });
      const codeUnknown = new URL(startUnknown.headers.get('location')!).searchParams.get('code')!;
      const exchangeUnknown = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeUnknown, codeVerifier: unknownFlow.pair.codeVerifier, redirectUri }),
      });
      assert.equal(exchangeUnknown.status, 200);
      const unknownBody = (await exchangeUnknown.json()) as DesktopHandoffExchangeResponse;
      assert.equal(unknownBody.interactiveLogin, true);
      assert.equal(unknownBody.oneTapVerified, true);
      assert.equal(unknownBody.planTier, 'unknown');
      assert.equal(unknownBody.pricingHandoffUrl, undefined);
    });

    it('guarantees single-use DesktopOidcProvenanceStore consumption across two API replicas sharing one cache', async () => {
      const sharedCache = new InMemoryAuthCache();
      const replicaA = new DesktopOidcProvenanceStore(sharedCache);
      const replicaB = new DesktopOidcProvenanceStore(sharedCache);

      await replicaA.save('prov_hash_atomic', {
        userId: 'u_atomic',
        codeChallenge: 'challenge_atomic',
        redirectUri: 'http://127.0.0.1:45200/callback',
        oneTapVerified: true,
      });

      const [resA, resB] = await Promise.all([
        replicaA.consume('prov_hash_atomic'),
        replicaB.consume('prov_hash_atomic'),
      ]);
      const winners = [resA, resB].filter(Boolean);
      assert.equal(winners.length, 1, 'Exactly one replica may consume a desktop provenance record');
      assert.equal(winners[0]?.oneTapVerified, true);
    });

    it('guarantees single-use /auth/desktop/exchange across two API replicas sharing one cache (1 session + 1 AMR ticket)', async () => {
      const config = makeConfig();
      const store = new InMemoryAuthStore();
      const sharedCache = new InMemoryAuthCache();
      const projected = await store.projectAmrUserAndWorkspace({
        oidcSub: 'ba_dual_replica',
        appUserId: 'usr_dual_replica',
        email: 'dual@example.test',
        displayName: 'Dual Replica',
        avatarUrl: null,
        externalWorkspaceId: 'ws_dual',
        workspaceName: 'Dual WS',
        role: 'owner',
      });
      const browserSession = await createBrowserSession(store, {
        userId: projected.user.id,
        workspaceId: projected.workspace.id,
      });

      let ticketMintCalls = 0;
      const makeAmrClient = () =>
        new AmrIdentityClient({
          apiUrl: 'https://amr-api.example.test',
          internalToken: 'internal-token',
          oneTapApiUrl: 'http://amr-api.internal.svc.cluster.local:18080',
          oneTapInternalToken: 'one-tap-internal-token',
          cache: sharedCache,
          fetcher: (async (input) => {
            const url = String(input);
            if (url.startsWith('https://amr-api.example.test/api/internal/identity/ba_dual_replica')) {
              return Response.json({
                active: true,
                status: 'active',
                authUserId: 'ba_dual_replica',
                appUserId: 'usr_dual_replica',
                email: 'dual@example.test',
                name: 'Dual Replica',
                image: null,
                workspace: {
                  workspaceId: 'ws_dual',
                  workspaceName: 'Dual WS',
                  workspaceType: 'personal',
                  workspaceMemberId: 'wm_dual',
                  role: 'owner',
                  lifecycleState: 'active',
                  effectiveWriteAccess: 'writable',
                },
              });
            }
            if (url === 'https://amr-api.example.test/api/internal/billing/summary/usr_dual_replica') {
              return Response.json({ membershipTier: null });
            }
            if (url === 'http://amr-api.internal.svc.cluster.local:18080/api/internal/auth/one-tap/handoff-ticket') {
              ticketMintCalls += 1;
              return Response.json({
                ticket: `ht_dual_${ticketMintCalls}`,
                handoffUrl: `https://amr-api.example.test/api/auth/one-tap/handoff?ticket=ht_dual_${ticketMintCalls}`,
                expiresAt: '2026-11-24T12:01:00.000Z',
              });
            }
            return new Response('Not Found', { status: 404 });
          }) as typeof fetch,
        });

      const provStoreA = new DesktopOidcProvenanceStore(sharedCache);
      const provStoreB = new DesktopOidcProvenanceStore(sharedCache);
      const replicaA = createDesktopHandoffRoutes(
        { config, store, cache: sharedCache, amrIdentity: makeAmrClient() },
        { oidcProvenanceStore: provStoreA },
      );
      const replicaB = createDesktopHandoffRoutes(
        { config, store, cache: sharedCache, amrIdentity: makeAmrClient() },
        { oidcProvenanceStore: provStoreB },
      );

      const pair = generatePkcePair();
      const redirectUri = 'http://127.0.0.1:45201/callback';
      const ctxRaw = 'dual_ctx_token_value';
      const { createHash } = await import('node:crypto');
      const ctxHash = createHash('sha256').update(ctxRaw).digest('hex');
      await provStoreA.save(ctxHash, {
        userId: projected.user.id,
        codeChallenge: pair.codeChallenge,
        redirectUri,
        oneTapVerified: true,
        sessionProof: 'otsp_dual_proof',
      });

      const startRes = await replicaA.request(
        buildStartUrl({
          code_challenge: pair.codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'st_dual',
        }),
        {
          headers: {
            Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}; ${DESKTOP_OIDC_CTX_COOKIE_NAME}=${ctxRaw}`,
          },
        },
      );
      assert.equal(startRes.status, 302);
      const code = new URL(startRes.headers.get('location')!).searchParams.get('code')!;
      const initialSessions = store.sessions.size;

      const [exA, exB] = await Promise.all([
        replicaA.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, codeVerifier: pair.codeVerifier, redirectUri }),
        }),
        replicaB.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, codeVerifier: pair.codeVerifier, redirectUri }),
        }),
      ]);
      const statuses = [exA.status, exB.status].sort();
      assert.deepEqual(statuses, [200, 401], 'Exactly one replica may exchange a desktop handoff code');
      assert.equal(store.sessions.size - initialSessions, 1, 'Exactly one desktop session may be created');
      assert.equal(ticketMintCalls, 1, 'Exactly one AMR Pricing handoff ticket may be minted');
    });
  });
});
