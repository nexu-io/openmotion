import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAuthRoutes } from '../../src/auth/routes.ts';
import type { AuthStore } from '../../src/auth/store.ts';
import type { OidcService } from '../../src/auth/oidc.ts';
import { parseConfig } from '../../src/infra/config.ts';

function makeConfig(authMode: 'dev' | 'oidc') {
  // AUTH_MODE=dev keeps /auth/login free of an OIDC round trip while the account-switch
  // handling (the code under test) still runs before the redirect.
  return parseConfig({
    NODE_ENV: 'test',
    WORKER_ROLE: 'api',
    APP_PUBLIC_ORIGIN: 'https://motion.example.test',
    AUTH_MODE: authMode,
    OIDC_ISSUER: 'https://idp.example.test',
    OIDC_CLIENT_ID: 'openmotion-cloud',
    SESSION_SECRET: '0'.repeat(32),
    MODEL_GATEWAY_MODE: 'mock',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
  });
}

const stubOidc = {
  async startLogin() {
    return { authorizationUrl: 'https://idp.example.test/authorize?x=1', txCookieValue: 'tx-value' };
  },
} as unknown as OidcService;

function buildApp(revocations: string[], authMode: 'dev' | 'oidc' = 'dev') {
  const store = {
    async revokeSessionByTokenHash(tokenHash: string) {
      revocations.push(tokenHash);
      return true;
    },
  } as unknown as AuthStore;
  return createAuthRoutes({
    config: makeConfig(authMode),
    store,
    ...(authMode === 'oidc' ? { oidc: stubOidc } : {}),
  });
}

const SESSION_COOKIE = `om_session=${'a'.repeat(40)}`;

describe('GET /auth/login?switch=1 CSRF defence', () => {
  it('does not revoke the session for a cross-site top-level navigation', async () => {
    const revocations: string[] = [];
    const app = buildApp(revocations);

    const response = await app.request('/auth/login?switch=1', {
      headers: { cookie: SESSION_COOKIE, 'sec-fetch-site': 'cross-site' },
    });

    assert.equal(response.status, 302);
    assert.deepEqual(revocations, [], 'cross-site switch must not destroy the session');
  });

  it('does not revoke the session when a foreign Origin is presented', async () => {
    const revocations: string[] = [];
    const app = buildApp(revocations);

    const response = await app.request('/auth/login?switch=1', {
      headers: {
        cookie: SESSION_COOKIE,
        origin: 'https://evil.example',
        'sec-fetch-site': 'same-origin',
      },
    });

    assert.equal(response.status, 302);
    assert.deepEqual(revocations, []);
  });

  it('revokes the session for a same-origin account switch', async () => {
    const revocations: string[] = [];
    const app = buildApp(revocations);

    const response = await app.request('/auth/login?switch=1', {
      headers: { cookie: SESSION_COOKIE, 'sec-fetch-site': 'same-origin' },
    });

    assert.equal(response.status, 302);
    assert.equal(revocations.length, 1);
  });

  it('revokes the session when the same-origin Origin header matches', async () => {
    const revocations: string[] = [];
    const app = buildApp(revocations);

    const response = await app.request('/auth/login?switch=1', {
      headers: { cookie: SESSION_COOKIE, origin: 'https://motion.example.test' },
    });

    assert.equal(response.status, 302);
    assert.equal(revocations.length, 1);
  });

  it('revokes the session for an initiator-less navigation such as the desktop switch', async () => {
    const revocations: string[] = [];
    const app = buildApp(revocations);

    // Electron opens the switch through the shell or loads it in-window: no Origin, no Referer,
    // and Sec-Fetch-Site is either absent or `none`.
    const initiatorLessHeaders: Array<Record<string, string>> = [
      { cookie: SESSION_COOKIE, 'sec-fetch-site': 'none' },
      { cookie: SESSION_COOKIE },
    ];
    for (const headers of initiatorLessHeaders) {
      revocations.length = 0;
      const response = await app.request('/auth/login?switch=1', { headers });
      assert.equal(response.status, 302);
      assert.equal(revocations.length, 1, `expected a revocation for ${JSON.stringify(headers)}`);
    }
  });

  it('does not revoke when only a cross-site Referer identifies the initiator', async () => {
    const revocations: string[] = [];
    const app = buildApp(revocations);

    const response = await app.request('/auth/login?switch=1', {
      headers: { cookie: SESSION_COOKIE, referer: 'https://evil.example/some/page' },
    });

    assert.equal(response.status, 302);
    assert.deepEqual(revocations, []);
  });

  it('does not revoke when only a same-origin Referer identifies the initiator', async () => {
    // A same-origin redirect hop can produce this Referer from an attacker-initiated navigation, so
    // the case fails closed. Browsers send Sec-Fetch-Site or Origin on real in-app navigations.
    const revocations: string[] = [];
    const app = buildApp(revocations);

    const response = await app.request('/auth/login?switch=1', {
      headers: { cookie: SESSION_COOKIE, referer: 'https://motion.example.test/studio' },
    });

    assert.equal(response.status, 302);
    assert.deepEqual(revocations, []);
  });

  it('rejects a cross-site hop even when it carries a same-origin Referer', async () => {
    // The desktop start route 302s into this route, so a same-origin Referer can be laundered from
    // an attacker-initiated navigation. Fetch metadata must win over the Referer fallback.
    const revocations: string[] = [];
    const app = buildApp(revocations);

    const response = await app.request('/auth/login?switch=1', {
      headers: {
        cookie: SESSION_COOKIE,
        'sec-fetch-site': 'cross-site',
        referer: 'https://motion.example.test/auth/desktop/start?switch=1',
      },
    });

    assert.equal(response.status, 302);
    assert.deepEqual(revocations, []);
  });

  it('leaves a plain login (no switch) untouched', async () => {
    const revocations: string[] = [];
    const app = buildApp(revocations);

    const response = await app.request('/auth/login', {
      headers: { cookie: SESSION_COOKIE },
    });

    assert.equal(response.status, 302);
    assert.deepEqual(revocations, []);
  });

  it('clears the session cookie only for a same-origin switch in OIDC mode', async () => {
    const sameOrigin: string[] = [];
    const sameOriginApp = buildApp(sameOrigin, 'oidc');
    const allowed = await sameOriginApp.request('/auth/login?switch=1', {
      headers: { cookie: SESSION_COOKIE, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(allowed.status, 302);
    assert.match(allowed.headers.get('set-cookie') ?? '', /om_session=;/);
    assert.equal(sameOrigin.length, 1);

    const crossSite: string[] = [];
    const crossSiteApp = buildApp(crossSite, 'oidc');
    const blocked = await crossSiteApp.request('/auth/login?switch=1', {
      headers: { cookie: SESSION_COOKIE, 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(blocked.status, 302, 'the login page still opens');
    assert.doesNotMatch(blocked.headers.get('set-cookie') ?? '', /om_session=;/);
    assert.deepEqual(crossSite, []);
  });
});