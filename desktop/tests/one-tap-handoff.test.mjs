import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DesktopAuthHandoffManager,
  resolveSafeDesktopPricingUrl,
  verifyElectronSessionDelivered,
} from '../src/auth-handoff.ts';

function makeExchangeResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test('P0-5 suspends loopback HTTP response until PKCE exchange and session delivery finish, then 302s interactive Free/Go to allowlisted Pricing URL', async () => {
  let releaseExchange;
  const exchangeGate = new Promise(resolve => {
    releaseExchange = resolve;
  });
  let releaseVerify;
  const verifyGate = new Promise(resolve => {
    releaseVerify = resolve;
  });

  let exchangeStarted = false;
  let verifyCalled = false;
  let responseSettled = false;

  const manager = new DesktopAuthHandoffManager({
    studioOrigin: 'https://motion.open-design.ai',
    openExternal: () => {},
    exchangeFetch: async () => {
      exchangeStarted = true;
      await exchangeGate;
      return makeExchangeResponse({
        ok: true,
        user: { id: 'u-free', email: 'free@open-design.ai', name: 'Free User' },
        workspaceId: 'ws-free',
        planTier: 'free',
        interactiveLogin: true,
      });
    },
    verifySessionDelivered: async ({ studioOrigin, workspaceId }) => {
      verifyCalled = true;
      assert.equal(studioOrigin, 'https://motion.open-design.ai');
      assert.equal(workspaceId, 'ws-free');
      await verifyGate;
      return true;
    },
    timeoutMs: 10_000,
    exchangeTimeoutMs: 5_000,
  });

  try {
    const started = await manager.startLogin();
    const cbUrl = new URL(started.redirectUri);
    cbUrl.searchParams.set('code', 'code_free_1');
    cbUrl.searchParams.set('state', started.state);

    const responsePromise = fetch(cbUrl, { redirect: 'manual' }).then(res => {
      responseSettled = true;
      return res;
    });

    // Wait briefly for loopback handler to trigger exchangeFetch
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(exchangeStarted, true, 'Expected exchangeFetch to have started');
    assert.equal(responseSettled, false, 'Loopback response MUST stay suspended while exchange is pending');

    // Duplicate callback while suspended gets 409 retryable error HTML without disrupting first request
    const dupRes = await fetch(cbUrl, { redirect: 'manual' });
    assert.equal(dupRes.status, 409);
    assert.match(await dupRes.text(), /Sign-in verification failed/);
    assert.equal(responseSettled, false);

    // Release exchangeFetch, keep verifySessionDelivered suspended
    releaseExchange();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(verifyCalled, true, 'Expected verifySessionDelivered to be called after exchange');
    assert.equal(responseSettled, false, 'Loopback response MUST stay suspended until session delivery is confirmed');

    // Release verifySessionDelivered -> now 302 redirect fires once and server closes
    releaseVerify();
    const res = await responsePromise;
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://open-design.ai/pricing');
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const finalState = await started.completion;
    assert.equal(finalState.status, 'authenticated');
    assert.equal(finalState.planTier, 'free');
    assert.equal(finalState.interactiveLogin, true);

    // Loopback server must be closed after responding
    await assert.rejects(() => fetch(started.redirectUri));
  } finally {
    manager.dispose();
  }
});

test('P0-5 returns 302 for interactive Go (with test pricing domain) and 200 HTML for Plus+, unknown, non-interactive fast-path, and untrusted pricing URLs', async () => {
  const cases = [
    {
      label: 'interactive Go on test studio origin -> 302 test pricing',
      studioOrigin: 'https://motion.open-design.powerformer.net',
      pricingUrl: undefined,
      payload: { planTier: 'go', interactiveLogin: true },
      expectedStatus: 302,
      expectedLocation: 'https://open-design.powerformer.net/pricing',
    },
    {
      label: 'non-interactive Free fast-path -> 200 success HTML (never 302)',
      studioOrigin: 'https://motion.open-design.ai',
      pricingUrl: undefined,
      payload: { planTier: 'free', interactiveLogin: false },
      expectedStatus: 200,
      expectedLocation: null,
    },
    {
      label: 'interactive Plus -> 200 success HTML',
      studioOrigin: 'https://motion.open-design.ai',
      pricingUrl: undefined,
      payload: { planTier: 'plus', interactiveLogin: true },
      expectedStatus: 200,
      expectedLocation: null,
    },
    {
      label: 'interactive Pro -> 200 success HTML',
      studioOrigin: 'https://motion.open-design.ai',
      pricingUrl: undefined,
      payload: { planTier: 'pro', interactiveLogin: true },
      expectedStatus: 200,
      expectedLocation: null,
    },
    {
      label: 'interactive unknown plan -> 200 success HTML',
      studioOrigin: 'https://motion.open-design.ai',
      pricingUrl: undefined,
      payload: { planTier: 'unknown', interactiveLogin: true },
      expectedStatus: 200,
      expectedLocation: null,
    },
    {
      label: 'interactive Free with account-bound pricingHandoffUrl -> 302 to handoffUrl',
      studioOrigin: 'https://motion.open-design.ai',
      pricingUrl: undefined,
      payload: {
        planTier: 'free',
        interactiveLogin: true,
        pricingHandoffUrl: 'https://amr-api.open-design.ai/api/auth/one-tap/handoff?ticket=ht_b_1',
      },
      expectedStatus: 302,
      expectedLocation: 'https://amr-api.open-design.ai/api/auth/one-tap/handoff?ticket=ht_b_1',
    },
    {
      label: 'interactive Free with failed ticket mint (pricingHandoffUrl: null) -> 200 success HTML (never unbound Pricing)',
      studioOrigin: 'https://motion.open-design.ai',
      pricingUrl: undefined,
      payload: {
        planTier: 'free',
        interactiveLogin: true,
        pricingHandoffUrl: null,
      },
      expectedStatus: 200,
      expectedLocation: null,
    },
    {
      label: 'untrusted pricingUrl override -> rejected and falls back to 200 success HTML',
      studioOrigin: 'https://motion.open-design.ai',
      pricingUrl: 'https://evil.example.com/pricing',
      payload: { planTier: 'free', interactiveLogin: true },
      expectedStatus: 200,
      expectedLocation: null,
    },
  ];

  for (const tc of cases) {
    const manager = new DesktopAuthHandoffManager({
      studioOrigin: tc.studioOrigin,
      pricingUrl: tc.pricingUrl,
      openExternal: () => {},
      exchangeFetch: async () =>
        makeExchangeResponse({
          ok: true,
          user: { id: 'u1', email: 'u@example.test', name: 'User' },
          workspaceId: 'ws1',
          ...tc.payload,
        }),
      verifySessionDelivered: async () => true,
      timeoutMs: 10_000,
      exchangeTimeoutMs: 5_000,
    });

    try {
      const started = await manager.startLogin();
      const cb = new URL(started.redirectUri);
      cb.searchParams.set('code', 'code_case');
      cb.searchParams.set('state', started.state);

      const res = await fetch(cb, { redirect: 'manual' });
      assert.equal(res.status, tc.expectedStatus, `Failed status for: ${tc.label}`);
      assert.equal(res.headers.get('location'), tc.expectedLocation, `Failed location for: ${tc.label}`);
      if (tc.expectedStatus === 200) {
        assert.match(await res.text(), /Sign-in complete/);
      }
      const finalState = await started.completion;
      assert.equal(finalState.status, 'authenticated');
    } finally {
      manager.dispose();
    }
  }
});

test('P0-5 returns retryable error HTML on session delivery failure, exchange timeout, and window-close cancel', async () => {
  // 1. Session delivery verification fails (window closed / om_session missing)
  const undeliveredManager = new DesktopAuthHandoffManager({
    studioOrigin: 'https://motion.open-design.ai',
    openExternal: () => {},
    exchangeFetch: async () =>
      makeExchangeResponse({
        ok: true,
        user: { id: 'u1', email: 'u@example.test', name: 'User' },
        workspaceId: 'ws1',
        planTier: 'free',
        interactiveLogin: true,
      }),
    verifySessionDelivered: async () => false,
    timeoutMs: 10_000,
    exchangeTimeoutMs: 5_000,
  });
  try {
    const started = await undeliveredManager.startLogin();
    const cb = new URL(started.redirectUri);
    cb.searchParams.set('code', 'code_undelivered');
    cb.searchParams.set('state', started.state);

    const res = await fetch(cb, { redirect: 'manual' });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('location'), null);
    assert.match(await res.text(), /Sign-in verification failed/);
    const finalState = await started.completion;
    assert.equal(finalState.status, 'error');
    assert.equal(finalState.errorCode, 'SESSION_DELIVERY_FAILED');
  } finally {
    undeliveredManager.dispose();
  }

  // 2. Exchange exceeds exchangeTimeoutMs -> 504 retryable error HTML
  const timeoutManager = new DesktopAuthHandoffManager({
    studioOrigin: 'https://motion.open-design.ai',
    openExternal: () => {},
    exchangeFetch: async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    timeoutMs: 10_000,
    exchangeTimeoutMs: 60,
  });
  try {
    const started = await timeoutManager.startLogin();
    const cb = new URL(started.redirectUri);
    cb.searchParams.set('code', 'code_timeout');
    cb.searchParams.set('state', started.state);

    const res = await fetch(cb, { redirect: 'manual' });
    assert.equal(res.status, 504);
    assert.match(await res.text(), /Sign-in verification failed/);
    const finalState = await started.completion;
    assert.equal(finalState.status, 'error');
    assert.equal(finalState.errorCode, 'EXCHANGE_TIMEOUT');
  } finally {
    timeoutManager.dispose();
  }

  // 3. Main window closes (cancelLogin) while exchange is in-flight -> 503 retryable error HTML
  const cancelManager = new DesktopAuthHandoffManager({
    studioOrigin: 'https://motion.open-design.ai',
    openExternal: () => {},
    exchangeFetch: async () => new Promise(() => {}),
    timeoutMs: 10_000,
    exchangeTimeoutMs: 5_000,
  });
  try {
    const started = await cancelManager.startLogin();
    const cb = new URL(started.redirectUri);
    cb.searchParams.set('code', 'code_cancel');
    cb.searchParams.set('state', started.state);

    const pendingRes = fetch(cb, { redirect: 'manual' });
    await new Promise(resolve => setTimeout(resolve, 40));
    cancelManager.cancelLogin();

    const res = await pendingRes;
    assert.equal(res.status, 503);
    assert.match(await res.text(), /Sign-in verification failed/);
    const finalState = await started.completion;
    assert.equal(finalState.status, 'canceled');
  } finally {
    cancelManager.dispose();
  }
});

test('resolveSafeDesktopPricingUrl enforces HTTPS open-design/powerformer allowlist and pricing path prefixes', () => {
  assert.equal(
    resolveSafeDesktopPricingUrl(undefined, 'https://motion.open-design.ai'),
    'https://open-design.ai/pricing',
  );
  assert.equal(
    resolveSafeDesktopPricingUrl(undefined, 'https://motion.open-design.powerformer.net'),
    'https://open-design.powerformer.net/pricing',
  );
  assert.equal(
    resolveSafeDesktopPricingUrl('https://open-design.ai/zh/pricing?utm_source=desktop', 'https://motion.open-design.ai'),
    'https://open-design.ai/zh/pricing?utm_source=desktop',
  );
  assert.equal(
    resolveSafeDesktopPricingUrl('http://open-design.ai/pricing', 'https://motion.open-design.ai'),
    null,
  );
  assert.equal(
    resolveSafeDesktopPricingUrl('https://evil.example.com/pricing', 'https://motion.open-design.ai'),
    null,
  );
  assert.equal(
    resolveSafeDesktopPricingUrl('https://open-design.ai/arbitrary', 'https://motion.open-design.ai'),
    null,
  );
  assert.equal(
    resolveSafeDesktopPricingUrl('https://open-design.ai/cloud/pricing', 'https://motion.open-design.ai'),
    null,
  );
});

test('P0-5 real /auth/me delivery check rejects stale Account A Electron cookie when Account B exchange returns 200', async () => {
  const studioOrigin = 'https://motion.open-design.ai';
  const meCalls = [];

  // Simulate Electron BrowserWindow cookie jar retaining Account A's old om_session cookie
  // even after POST /auth/desktop/exchange returns 200 for Account B.
  let activeCookie = 'om_session_account_A';
  let flushCalled = 0;

  const mockElectronWindow = {
    isDestroyed: () => false,
    webContents: {
      session: {
        cookies: {
          flushStore: async () => {
            flushCalled += 1;
          },
          get: async ({ url, name }) => {
            assert.equal(url, studioOrigin);
            assert.equal(name, 'om_session');
            return activeCookie ? [{ value: activeCookie }] : [];
          },
        },
        fetch: async (url, init) => {
          meCalls.push({ url, init, cookie: activeCookie });
          assert.equal(url, `${studioOrigin}/auth/me`);
          assert.equal(init.method, 'GET');
          assert.equal(init.credentials, 'include');
          if (activeCookie === 'om_session_account_A') {
            return {
              ok: true,
              json: async () => ({
                authenticated: true,
                user: { id: 'user-A', email: 'a@open-design.ai', displayName: 'Account A' },
                activeWorkspaceId: 'ws-A',
              }),
            };
          }
          if (activeCookie === 'om_session_account_B_wrong_ws') {
            return {
              ok: true,
              json: async () => ({
                authenticated: true,
                user: { id: 'user-B', email: 'b@open-design.ai', displayName: 'Account B' },
                activeWorkspaceId: 'ws-old',
              }),
            };
          }
          return {
            ok: true,
            json: async () => ({
              authenticated: true,
              user: { id: 'user-B', email: 'b@open-design.ai', displayName: 'Account B' },
              activeWorkspaceId: 'ws-B',
            }),
          };
        },
      },
    },
  };

  const makeManager = () =>
    new DesktopAuthHandoffManager({
      studioOrigin,
      openExternal: () => {},
      exchangeFetch: async () =>
        makeExchangeResponse({
          ok: true,
          user: { id: 'user-B', email: 'b@open-design.ai', name: 'Account B' },
          workspaceId: 'ws-B',
          planTier: 'free',
          interactiveLogin: true,
          oneTapVerified: true,
          pricingHandoffUrl: 'https://amr-api.open-design.ai/api/auth/one-tap/handoff?ticket=ht_b_real',
        }),
      verifySessionDelivered: context => verifyElectronSessionDelivered(() => mockElectronWindow, context),
      timeoutMs: 10_000,
      exchangeTimeoutMs: 5_000,
    });

  // Case 1: Electron jar still holds Account A -> /auth/me returns user-A -> 503 retryable HTML, NO Pricing 302
  const staleManager = makeManager();
  try {
    const started = await staleManager.startLogin();
    const cb = new URL(started.redirectUri);
    cb.searchParams.set('code', 'code_b_stale');
    cb.searchParams.set('state', started.state);

    const res = await fetch(cb, { redirect: 'manual' });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('location'), null);
    assert.match(await res.text(), /Sign-in verification failed/);
    const finalState = await started.completion;
    assert.equal(finalState.status, 'error');
    assert.equal(finalState.errorCode, 'SESSION_DELIVERY_FAILED');
    assert.ok(flushCalled >= 1);
    assert.equal(meCalls.length, 1);
    assert.equal(meCalls[0].cookie, 'om_session_account_A');
  } finally {
    staleManager.dispose();
  }

  // Case 2: User matches B but workspace mismatches -> 503 retryable HTML, NO Pricing 302
  activeCookie = 'om_session_account_B_wrong_ws';
  const wrongWsManager = makeManager();
  try {
    const started = await wrongWsManager.startLogin();
    const cb = new URL(started.redirectUri);
    cb.searchParams.set('code', 'code_b_wrong_ws');
    cb.searchParams.set('state', started.state);

    const res = await fetch(cb, { redirect: 'manual' });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('location'), null);
    assert.match(await res.text(), /Sign-in verification failed/);
    const finalState = await started.completion;
    assert.equal(finalState.status, 'error');
    assert.equal(finalState.errorCode, 'SESSION_DELIVERY_FAILED');
  } finally {
    wrongWsManager.dispose();
  }

  // Case 3: Cookie jar actually updated to Account B + ws-B -> /auth/me confirms B -> 302 Pricing handoff succeeds
  activeCookie = 'om_session_account_B';
  const okManager = makeManager();
  try {
    const started = await okManager.startLogin();
    const cb = new URL(started.redirectUri);
    cb.searchParams.set('code', 'code_b_ok');
    cb.searchParams.set('state', started.state);

    const res = await fetch(cb, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(
      res.headers.get('location'),
      'https://amr-api.open-design.ai/api/auth/one-tap/handoff?ticket=ht_b_real',
    );
    const finalState = await started.completion;
    assert.equal(finalState.status, 'authenticated');
    assert.equal(finalState.user?.id, 'user-B');
    assert.equal(finalState.workspaceId, 'ws-B');
  } finally {
    okManager.dispose();
  }
});
