import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import {
  DESKTOP_HANDOFF_EXCHANGE_PATH,
  DESKTOP_HANDOFF_START_PATH,
  DESKTOP_HANDOFF_TTL_SEC,
  type DesktopHandoffExchangeResponse,
} from '../../shared/desktop-auth-handoff.ts';
import { createDesktopHandoffRoutes } from '../../src/auth/desktop-handoff.ts';
import {
  InMemoryAuthCache,
  InMemoryAuthStore,
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

    it('rejects cross-site Origin / Sec-Fetch-Site headers on exchange while permitting native Electron calls without Origin', async () => {
      const config = makeConfig();
      const store = new InMemoryAuthStore();
      const cache = new InMemoryAuthCache();
      const seeded = store.seedWorkspace({
        email: 'csrf@example.test',
        displayName: 'CSRF Tester',
        role: 'owner',
      });
      const browserSession = await createBrowserSession(store, {
        userId: seeded.user.id,
        workspaceId: seeded.workspace.id,
      });

      const app = new Hono<AuthEnv>();
      app.route('/', createAuthRoutes({ config, store, cache }));

      const { codeVerifier, codeChallenge } = generatePkcePair();
      const redirectUri = 'http://127.0.0.1:45201/cb';
      const startRes = await app.request(
        buildStartUrl({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'csrf-check',
        }),
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` } },
      );
      const code = new URL(startRes.headers.get('location')!).searchParams.get('code')!;

      const crossOriginRes = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.example.com',
        },
        body: JSON.stringify({ code, codeVerifier, redirectUri }),
      });
      assert.equal(crossOriginRes.status, 403);
      assert.equal(((await crossOriginRes.json()) as { code: string }).code, 'CSRF_FORBIDDEN');

      const crossSiteRes = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'cross-site',
        },
        body: JSON.stringify({ code, codeVerifier, redirectUri }),
      });
      assert.equal(crossSiteRes.status, 403);

      // Legitimate Electron native exchange without Origin still succeeds because CSRF checks ran before consume.
      const nativeRes = await app.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier, redirectUri }),
      });
      assert.equal(nativeRes.status, 200);
    });

    it('consumes handoff codes atomically across two API instances sharing a cache', async () => {
      const config = makeConfig();
      const store = new InMemoryAuthStore();
      const sharedCache = new InMemoryAuthCache();
      const seeded = store.seedWorkspace({
        email: 'atomic@example.test',
        displayName: 'Atomic Tester',
        role: 'owner',
      });
      const browserSession = await createBrowserSession(store, {
        userId: seeded.user.id,
        workspaceId: seeded.workspace.id,
      });

      const appA = new Hono<AuthEnv>();
      appA.route('/', createAuthRoutes({ config, store, cache: sharedCache }));
      const appB = new Hono<AuthEnv>();
      appB.route('/', createAuthRoutes({ config, store, cache: sharedCache }));

      const { codeVerifier, codeChallenge } = generatePkcePair();
      const redirectUri = 'http://127.0.0.1:45202/cb';
      const startRes = await appA.request(
        buildStartUrl({
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          redirect_uri: redirectUri,
          state: 'atomic-multi-instance',
        }),
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` } },
      );
      const code = new URL(startRes.headers.get('location')!).searchParams.get('code')!;

      const [resA, resB] = await Promise.all([
        appA.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, codeVerifier, redirectUri }),
        }),
        appB.request(DESKTOP_HANDOFF_EXCHANGE_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, codeVerifier, redirectUri }),
        }),
      ]);
      assert.deepEqual([resA.status, resB.status].sort((a, b) => a - b), [200, 401]);
    });
  });
});
