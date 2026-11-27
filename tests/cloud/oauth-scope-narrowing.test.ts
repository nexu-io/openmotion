import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_PAT_SCOPES, type PatScope } from '../../src/contracts/auth.ts';
import { createAuthRoutes } from '../../src/auth/routes.ts';
import { parseConfig } from '../../src/infra/config.ts';
import { buildOAuth21Config, parseScopeString, validateAuthorizeRequest } from '../../src/auth/oauth21.ts';
import type { AuthStore } from '../../src/auth/store.ts';

const SUPPORTED: readonly PatScope[] = DEFAULT_PAT_SCOPES;

function makeConfig() {
  return parseConfig({
    NODE_ENV: 'test',
    WORKER_ROLE: 'api',
    APP_PUBLIC_ORIGIN: 'https://motion.example.test',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example.test',
    OIDC_CLIENT_ID: 'openmotion-cloud',
    SESSION_SECRET: '0'.repeat(32),
    MODEL_GATEWAY_MODE: 'mock',
    MCP_OAUTH_MODE: 'proxy',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
  });
}

function stubStore(redirectUri: string): AuthStore {
  const clientId = 'om_client_test';
  return {
    async findOAuthClient(requested: string) {
      if (requested !== clientId) return null;
      return {
        clientId,
        clientName: 'Test client',
        clientSecretHash: null,
        redirectUris: [redirectUri],
        grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethod: 'none',
        metadata: {},
        createdAt: new Date(),
      };
    },
  } as unknown as AuthStore;
}

const REDIRECT = 'http://127.0.0.1:33418/callback';
const CHALLENGE = 'a'.repeat(43);

function params(scope?: string) {
  return {
    clientId: 'om_client_test',
    redirectUri: REDIRECT,
    responseType: 'code',
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256',
    ...(scope === undefined ? {} : { scope }),
  };
}

describe('OAuth scope parsing never widens an explicit request', () => {
  it('keeps the default set only when the request omits scope', () => {
    assert.deepEqual(parseScopeString(undefined, SUPPORTED), [...SUPPORTED]);
    assert.deepEqual(parseScopeString('   ', SUPPORTED), [...SUPPORTED]);
  });

  it('returns only the recognised scopes of an explicit request', () => {
    assert.deepEqual(parseScopeString('projects:read openid profile', SUPPORTED), ['projects:read']);
    assert.deepEqual(parseScopeString('assets:read assets:write', SUPPORTED), ['assets:read', 'assets:write']);
  });

  it('returns an empty list when no requested scope is supported', () => {
    assert.deepEqual(parseScopeString('openid profile email', SUPPORTED), []);
    assert.deepEqual(parseScopeString('bogus', SUPPORTED), []);
  });
});

describe('validateAuthorizeRequest scope handling', () => {
  const cfg = buildOAuth21Config(makeConfig());
  const store = stubStore(REDIRECT);

  it('rejects an unsupported scope request with invalid_scope instead of granting everything', async () => {
    await assert.rejects(
      () => validateAuthorizeRequest(store, cfg, params('openid profile email')),
      (error: unknown) => {
        assert.match(String(error), /invalid_scope/);
        return true;
      },
    );
  });

  it('grants exactly the requested supported subset', async () => {
    const validated = await validateAuthorizeRequest(store, cfg, params('projects:read assets:read'));
    assert.deepEqual(validated.scopes, ['projects:read', 'assets:read']);
    assert.equal(validated.scope, 'projects:read assets:read');
  });

  it('still grants the default set when scope is omitted, without workspace:admin', async () => {
    const validated = await validateAuthorizeRequest(store, cfg, params());
    assert.deepEqual(validated.scopes, [...SUPPORTED]);
    assert.equal(validated.scopes.includes('workspace:admin'), false);
  });

  it('never grants workspace:admin even when it is the only requested scope', async () => {
    await assert.rejects(() => validateAuthorizeRequest(store, cfg, params('workspace:admin')));
  });
});

describe('OAuth token scope parsing stays fail-closed', () => {
  it('does not resurrect a scope from an empty stored value', () => {
    assert.deepEqual(parseScopeString('', []), []);
    assert.deepEqual(parseScopeString('bogus', []), []);
  });
});

describe('authorize route surfaces the OAuth error code', () => {
  const redirectUri = 'http://127.0.0.1:33418/callback';
  const store = {
    async findOAuthClient(requested: string) {
      if (requested !== 'om_client_route') return null;
      return {
        clientId: 'om_client_route',
        clientName: 'Route client',
        clientSecretHash: null,
        redirectUris: [redirectUri],
        grantTypes: ['authorization_code'],
        tokenEndpointAuthMethod: 'none',
        metadata: {},
        createdAt: new Date(),
      };
    },
  } as unknown as AuthStore;

  function authorizeUrl(scope: string): string {
    const url = new URL('https://motion.example.test/oauth/authorize');
    url.searchParams.set('client_id', 'om_client_route');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('code_challenge', 'a'.repeat(43));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('scope', scope);
    return url.pathname + url.search;
  }

  it('returns invalid_scope as the machine readable error for an unsupported scope', async () => {
    const app = createAuthRoutes({ config: makeConfig(), store });
    const response = await app.request(authorizeUrl('openid profile email'));

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error?: string; error_description?: string };
    assert.equal(body.error, 'invalid_scope');
    assert.equal(body.error_description, 'none of the requested scopes are supported');
  });

  it('does not report invalid_scope when the request names a supported scope', async () => {
    const app = createAuthRoutes({ config: makeConfig(), store });
    const response = await app.request(authorizeUrl('projects:read'));

    assert.notEqual(response.status, 400);
  });
});