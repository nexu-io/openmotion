import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DESKTOP_HANDOFF_EXCHANGE_PATH,
  DESKTOP_HANDOFF_START_PATH,
  isValidDesktopLoopbackRedirectUri,
} from '../../shared/desktop-auth-handoff.ts';
import {
  DEFAULT_STUDIO_URLS,
  DESKTOP_APP_ID,
  DESKTOP_DATA_LAYOUT_VERSION,
  DESKTOP_PROTOCOL_SCHEME,
} from '../../shared/desktop-builtin-rules.ts';
import {
  derivePkceChallengeS256,
  DesktopAuthHandoffManager,
  generatePkceVerifier,
  parseStudioAuthNavigationUrl,
  probeDesktopHandoffSupport,
  sanitizeAuthReturnPath,
  timingSafeEqualStrings,
} from '../src/auth-handoff.ts';
import {
  CapabilityRegistry,
  createAccountCapabilityModule,
} from '../src/capability-registry.ts';
import {
  DESKTOP_DATA_SUBDIRS,
  DesktopDataLayoutVersionError,
  ensureDesktopDataLayout,
  readDesktopDataLayoutMetadata,
  resolveLayoutSubpath,
} from '../src/data-layout.ts';
import {
  DesktopProtocolRouter,
  extractDeepLinkFromArgv,
  parseDesktopDeepLink,
  registerDesktopProtocolClient,
} from '../src/protocol.ts';
import {
  attachWindowNavigationPolicies,
  evaluateNavigationPolicy,
  evaluateWindowOpenPolicy,
  isBillingOrAccountPortalUrl,
  POPUP_HARDENED_WEB_PREFERENCES,
  resolveDefaultFallbackAuthOrigins,
} from '../src/window-policy.ts';
import { authorizePrivilegedIpcSender } from '../src/ipc-guard.ts';
import { resolvePackagedReleaseChannel } from '../src/updater.ts';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeTempDir(prefix) {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

async function startStubServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return {
    server,
    origin: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      }),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

test('K2 navigation policy allows same-origin Studio, gates auth fallback, routes billing/external out, and denies dangerous schemes', () => {
  const baseConfig = {
    studioOrigin: 'https://motion.open-design.ai',
    channel: 'stable',
    allowedOrigins: ['https://studio.open-design.ai', 'https://evil.example.com'],
    windowPolicy: {
      allowedAuthOrigins: ['https://auth.open-design.ai', 'https://untrusted.example.com'],
      allowedPopupOrigins: ['https://preview.open-design.ai', 'https://evil.example.com'],
      allowBlankPopups: true,
    },
    explicitIdpAuthOrigins: ['https://accounts.google.com', 'http://insecure-idp.example.com'],
    inWindowAuthFallbackActive: false,
  };

  // Same-origin Studio URL allowed
  const sameOrigin = evaluateNavigationPolicy('https://motion.open-design.ai/projects/abc', baseConfig);
  assert.equal(sameOrigin.action, 'allow');
  assert.equal(sameOrigin.reason, 'same-origin-studio');
  assert.equal(sameOrigin.openExternal, false);

  // In-scope allowedOrigin allowed; out-of-scope allowedOrigin rejected to external
  const allowedSubdomain = evaluateNavigationPolicy('https://studio.open-design.ai/workflows', baseConfig);
  assert.equal(allowedSubdomain.action, 'allow');
  assert.equal(allowedSubdomain.reason, 'allowed-origin');

  const outOfScopeAllowed = evaluateNavigationPolicy('https://evil.example.com/phish', baseConfig);
  assert.equal(outOfScopeAllowed.action, 'deny');
  assert.equal(outOfScopeAllowed.openExternal, true);

  // Auth origins denied in main window when fallback is NOT active
  const authWhenInactive = evaluateNavigationPolicy('https://auth.open-design.ai/login', baseConfig);
  assert.equal(authWhenInactive.action, 'deny');
  assert.equal(authWhenInactive.openExternal, true);

  const idpWhenInactive = evaluateNavigationPolicy('https://accounts.google.com/o/oauth2/v2/auth', baseConfig);
  assert.equal(idpWhenInactive.action, 'deny');
  assert.equal(idpWhenInactive.openExternal, true);

  // Auth origins allowed ONLY when in-window fallback is explicitly active
  const fallbackConfig = { ...baseConfig, inWindowAuthFallbackActive: true };
  const signedAuthAllowed = evaluateNavigationPolicy('https://auth.open-design.ai/login', fallbackConfig);
  assert.equal(signedAuthAllowed.action, 'allow');
  assert.equal(signedAuthAllowed.reason, 'auth-fallback-origin');

  const explicitIdpAllowed = evaluateNavigationPolicy(
    'https://accounts.google.com/o/oauth2/v2/auth',
    fallbackConfig,
  );
  assert.equal(explicitIdpAllowed.action, 'allow');
  assert.equal(explicitIdpAllowed.reason, 'auth-fallback-origin');

  // Out-of-scope signed auth origin and non-HTTPS explicit IdP are still rejected
  const untrustedAuth = evaluateNavigationPolicy('https://untrusted.example.com/login', fallbackConfig);
  assert.equal(untrustedAuth.action, 'deny');
  assert.equal(untrustedAuth.openExternal, true);

  const insecureIdp = evaluateNavigationPolicy('http://insecure-idp.example.com/login', fallbackConfig);
  assert.equal(insecureIdp.action, 'deny');
  assert.equal(insecureIdp.openExternal, true);

  // Billing / subscription / account portal detection & external redirection
  assert.equal(isBillingOrAccountPortalUrl('https://billing.stripe.com/p/session/test_123'), true);
  assert.equal(isBillingOrAccountPortalUrl('https://checkout.stripe.com/c/pay/cs_123'), true);
  assert.equal(isBillingOrAccountPortalUrl('https://motion.open-design.ai/billing'), true);
  assert.equal(isBillingOrAccountPortalUrl('https://motion.open-design.ai/settings/billing'), true);
  assert.equal(isBillingOrAccountPortalUrl('https://account.open-design.ai/subscription'), true);
  assert.equal(isBillingOrAccountPortalUrl('https://motion.open-design.ai/projects/123'), false);
  assert.equal(isBillingOrAccountPortalUrl('https://motion.open-design.ai/settings'), false);

  const sameOriginBilling = evaluateNavigationPolicy('https://motion.open-design.ai/billing', baseConfig);
  assert.equal(sameOriginBilling.action, 'deny');
  assert.equal(sameOriginBilling.reason, 'billing-external');
  assert.equal(sameOriginBilling.openExternal, true);
  assert.equal(sameOriginBilling.isBillingOrAccountPortal, true);

  const stripeBilling = evaluateNavigationPolicy('https://billing.stripe.com/p/session/live_1', baseConfig);
  assert.equal(stripeBilling.action, 'deny');
  assert.equal(stripeBilling.reason, 'billing-external');
  assert.equal(stripeBilling.openExternal, true);
  assert.equal(stripeBilling.isBillingOrAccountPortal, true);

  // External URLs redirected to system browser
  const externalDocs = evaluateNavigationPolicy('https://docs.example.org/guide', baseConfig);
  assert.equal(externalDocs.action, 'deny');
  assert.equal(externalDocs.reason, 'external-url');
  assert.equal(externalDocs.openExternal, true);
  assert.equal(externalDocs.isBillingOrAccountPortal, false);

  // Dangerous schemes and credential URLs strictly denied without opening externally
  for (const dangerous of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://motion.open-design.ai/1234',
    'vbscript:msgbox(1)',
    'https://user:pass@motion.open-design.ai/',
    'not-a-valid-url',
  ]) {
    const res = evaluateNavigationPolicy(dangerous, baseConfig);
    assert.equal(res.action, 'deny', `Expected deny for ${dangerous}`);
    assert.equal(res.openExternal, false, `Expected openExternal=false for ${dangerous}`);
  }
});

test('K2 popup policy allows about:blank and same-origin popups WITHOUT preload, routes external to browser, and denies dangerous schemes', () => {
  const config = {
    studioOrigin: 'https://motion.open-design.ai',
    channel: 'stable',
    windowPolicy: {
      allowedPopupOrigins: ['https://preview.open-design.ai', 'https://attacker.example.com'],
      allowBlankPopups: true,
    },
  };

  // about:blank allowed for render preview / presenter view, stripped of preload
  const blankPopup = evaluateWindowOpenPolicy('about:blank', config);
  assert.equal(blankPopup.action, 'allow');
  assert.equal(blankPopup.reason, 'blank-popup');
  assert.deepEqual(blankPopup.overrideBrowserWindowOptions.webPreferences, POPUP_HARDENED_WEB_PREFERENCES);
  assert.equal(blankPopup.overrideBrowserWindowOptions.webPreferences.preload, undefined);
  assert.equal(blankPopup.overrideBrowserWindowOptions.webPreferences.contextIsolation, true);
  assert.equal(blankPopup.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  assert.equal(blankPopup.overrideBrowserWindowOptions.webPreferences.sandbox, true);

  // about:blank denied when explicitly disabled by signed config
  const blankDisabled = evaluateWindowOpenPolicy('about:blank', {
    ...config,
    windowPolicy: { allowBlankPopups: false },
  });
  assert.equal(blankDisabled.action, 'deny');
  assert.equal(blankDisabled.reason, 'blank-popup-disabled');
  assert.equal(blankDisabled.openExternal, false);

  // Same-origin Studio popup allowed without preload
  const sameOriginPopup = evaluateWindowOpenPolicy(
    'https://motion.open-design.ai/presenter/proj_1',
    config,
  );
  assert.equal(sameOriginPopup.action, 'allow');
  assert.equal(sameOriginPopup.reason, 'same-origin-popup');
  assert.equal(sameOriginPopup.overrideBrowserWindowOptions.webPreferences.preload, undefined);
  assert.equal(sameOriginPopup.overrideBrowserWindowOptions.webPreferences.sandbox, true);

  // In-scope allowedPopupOrigins allowed without preload; out-of-scope routed externally
  const previewPopup = evaluateWindowOpenPolicy('https://preview.open-design.ai/render/1', config);
  assert.equal(previewPopup.action, 'allow');
  assert.equal(previewPopup.reason, 'allowed-popup-origin');
  assert.equal(previewPopup.overrideBrowserWindowOptions.webPreferences.preload, undefined);

  const attackerPopup = evaluateWindowOpenPolicy('https://attacker.example.com/popup', config);
  assert.equal(attackerPopup.action, 'deny');
  assert.equal(attackerPopup.openExternal, true);

  // Billing popup routed to system browser even on same origin
  const billingPopup = evaluateWindowOpenPolicy('https://motion.open-design.ai/checkout', config);
  assert.equal(billingPopup.action, 'deny');
  assert.equal(billingPopup.reason, 'billing-external');
  assert.equal(billingPopup.openExternal, true);
  assert.equal(billingPopup.isBillingOrAccountPortal, true);

  // External HTTP/HTTPS popup denied and opened in system browser
  const externalPopup = evaluateWindowOpenPolicy('https://github.com/nexu-io/openmotion', config);
  assert.equal(externalPopup.action, 'deny');
  assert.equal(externalPopup.reason, 'external-popup');
  assert.equal(externalPopup.openExternal, true);

  // Dangerous schemes denied without opening external
  for (const dangerous of ['javascript:void(0)', 'file:///tmp/x.html', 'data:text/html,hi']) {
    const res = evaluateWindowOpenPolicy(dangerous, config);
    assert.equal(res.action, 'deny');
    assert.equal(res.openExternal, false);
  }
});

test('K2 attachWindowNavigationPolicies hooks will-navigate, will-redirect, and setWindowOpenHandler', () => {
  const listeners = new Map();
  let windowOpenHandler = null;
  const openedExternal = [];

  const fakeWebContents = {
    on(event, fn) {
      listeners.set(event, fn);
    },
    setWindowOpenHandler(fn) {
      windowOpenHandler = fn;
    },
  };

  attachWindowNavigationPolicies(fakeWebContents, {
    getConfig: () => ({
      studioOrigin: 'https://motion.open-design.ai',
      channel: 'stable',
    }),
    openExternal: (url, ctx) => {
      openedExternal.push({ url, ...ctx });
    },
  });

  // Same-origin navigation does NOT prevent default
  let prevented = false;
  listeners.get('will-navigate')({ preventDefault: () => { prevented = true; } }, 'https://motion.open-design.ai/home');
  assert.equal(prevented, false);

  // Billing redirect prevents default and opens externally with billing flag
  prevented = false;
  listeners.get('will-redirect')(
    { preventDefault: () => { prevented = true; } },
    'https://billing.stripe.com/p/session/abc',
  );
  assert.equal(prevented, true);
  assert.deepEqual(openedExternal[0], {
    url: 'https://billing.stripe.com/p/session/abc',
    source: 'redirect',
    isBillingOrAccountPortal: true,
  });

  // Popup handler allows about:blank with hardened webPreferences
  const blankResult = windowOpenHandler({ url: 'about:blank' });
  assert.equal(blankResult.action, 'allow');
  assert.equal(blankResult.overrideBrowserWindowOptions.webPreferences.preload, undefined);
  assert.equal(blankResult.overrideBrowserWindowOptions.webPreferences.sandbox, true);

  // Popup handler denies external URL and routes to openExternal
  const externalResult = windowOpenHandler({ url: 'https://example.org/docs' });
  assert.equal(externalResult.action, 'deny');
  assert.deepEqual(openedExternal[1], {
    url: 'https://example.org/docs',
    source: 'popup',
    isBillingOrAccountPortal: false,
  });
});

test('K3 PKCE S256 handoff completes end-to-end against stub cloud server and rejects mismatched state', async () => {
  // Verify RFC 7636 S256 test vector
  const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(
    derivePkceChallengeS256(rfcVerifier),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
  assert.ok(generatePkceVerifier().length >= 43);
  assert.equal(timingSafeEqualStrings('abc', 'abc'), true);
  assert.equal(timingSafeEqualStrings('abc', 'abd'), false);
  assert.equal(timingSafeEqualStrings('abc', 'abcd'), false);
  assert.equal(timingSafeEqualStrings('', ''), false);

  const expectedCode = 'handoff_code_single_use_987654';
  const exchangeCalls = [];
  let expectedChallenge = '';
  let expectedRedirectUri = '';
  let capturedSetCookie = '';

  const stubCloud = await startStubServer(async (req, res) => {
    if (req.method === 'POST' && req.url === DESKTOP_HANDOFF_EXCHANGE_PATH) {
      const body = await readJsonBody(req);
      exchangeCalls.push(body);
      if (
        body.code !== expectedCode ||
        body.redirectUri !== expectedRedirectUri ||
        derivePkceChallengeS256(body.codeVerifier) !== expectedChallenge
      ) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'pkce_mismatch' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'om_session=sess_cloud_cookie_1; HttpOnly; Path=/; SameSite=Lax',
      });
      res.end(
        JSON.stringify({
          ok: true,
          user: { id: 'usr_42', email: 'designer@open-design.ai', name: 'Designer' },
          workspaceId: 'ws_main_42',
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  const openedUrls = [];
  const stateHistory = [];
  let focusCount = 0;

  const manager = new DesktopAuthHandoffManager({
    studioOrigin: stubCloud.origin,
    openExternal: url => {
      openedUrls.push(url);
    },
    exchangeFetch: async (url, init) => {
      const res = await fetch(url, init);
      capturedSetCookie = res.headers.get('set-cookie') ?? '';
      return res;
    },
    onFocusMainWindow: () => {
      focusCount += 1;
    },
    timeoutMs: 10_000,
  });

  const unsubscribe = manager.subscribe(state => stateHistory.push(state.status));

  try {
    // In-window fallback helper
    assert.equal(manager.openInWindowFallback(), `${stubCloud.origin}/auth/login`);
    assert.equal(
      manager.openInWindowFallback({ switchAccount: true }),
      `${stubCloud.origin}/auth/login?switch=1`,
    );

    const started = await manager.startLogin({ switchAccount: true });
    assert.equal(openedUrls.length, 1);
    assert.equal(openedUrls[0], started.startUrl);
    assert.equal(isValidDesktopLoopbackRedirectUri(started.redirectUri), true);

    const parsedStart = new URL(started.startUrl);
    assert.equal(parsedStart.pathname, DESKTOP_HANDOFF_START_PATH);
    assert.equal(parsedStart.searchParams.get('code_challenge'), started.codeChallenge);
    assert.equal(parsedStart.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(parsedStart.searchParams.get('redirect_uri'), started.redirectUri);
    assert.equal(parsedStart.searchParams.get('state'), started.state);
    assert.equal(parsedStart.searchParams.get('switch'), '1');

    expectedChallenge = started.codeChallenge;
    expectedRedirectUri = started.redirectUri;

    // Non-callback path returns 404 without disrupting pending login
    const faviconRes = await fetch(new URL('/favicon.ico', started.redirectUri));
    assert.equal(faviconRes.status, 404);
    assert.equal(manager.getState().status, 'pending');

    // Forged callback with mismatched state is rejected (400) and never calls exchangeFetch
    const badStateUrl = new URL(started.redirectUri);
    badStateUrl.searchParams.set('code', 'forged_code');
    badStateUrl.searchParams.set('state', 'wrong_state_value');
    const badStateRes = await fetch(badStateUrl);
    assert.equal(badStateRes.status, 400);
    const badStateHtml = await badStateRes.text();
    assert.equal(badStateHtml.includes('<script'), false);
    assert.equal(badStateHtml.includes('forged_code'), false);
    assert.equal(exchangeCalls.length, 0);
    assert.equal(manager.getState().status, 'pending');

    // Missing code is rejected (400) and never calls exchangeFetch
    const missingCodeUrl = new URL(started.redirectUri);
    missingCodeUrl.searchParams.set('state', started.state);
    const missingCodeRes = await fetch(missingCodeUrl);
    assert.equal(missingCodeRes.status, 400);
    assert.equal(exchangeCalls.length, 0);

    // Valid callback succeeds with clean static HTML and triggers session exchange
    const validCallbackUrl = new URL(started.redirectUri);
    validCallbackUrl.searchParams.set('code', expectedCode);
    validCallbackUrl.searchParams.set('state', started.state);
    const validRes = await fetch(validCallbackUrl);
    assert.equal(validRes.status, 200);
    const validHtml = await validRes.text();
    assert.match(validHtml, /Sign-in complete — you can close this tab and return to OpenDesign/);
    assert.equal(validHtml.includes('<script'), false);
    assert.equal(validHtml.includes(expectedCode), false);
    assert.equal(validHtml.includes(started.state), false);

    const finalState = await started.completion;
    assert.equal(finalState.status, 'authenticated');
    assert.equal(finalState.workspaceId, 'ws_main_42');
    assert.deepEqual(finalState.user, {
      id: 'usr_42',
      email: 'designer@open-design.ai',
      name: 'Designer',
    });
    assert.equal(exchangeCalls.length, 1);
    assert.equal(exchangeCalls[0].code, expectedCode);
    assert.equal(exchangeCalls[0].redirectUri, started.redirectUri);
    assert.equal(derivePkceChallengeS256(exchangeCalls[0].codeVerifier), started.codeChallenge);
    assert.match(capturedSetCookie, /om_session=sess_cloud_cookie_1/);
    assert.equal(focusCount, 1);
    assert.deepEqual(stateHistory, ['pending', 'exchanging', 'authenticated']);
  } finally {
    unsubscribe();
    manager.dispose();
    await stubCloud.close();
  }
});

test('K3 DesktopAuthHandoffManager handles cancellation, timeout, and exchange failure cleanly', async () => {
  // 1. Cancellation closes loopback server and resolves completion as canceled
  const cancelManager = new DesktopAuthHandoffManager({
    studioOrigin: 'https://motion.open-design.ai',
    openExternal: () => {},
    exchangeFetch: async () => {
      throw new Error('should not be called');
    },
    timeoutMs: 10_000,
  });
  try {
    const started = await cancelManager.startLogin();
    const canceled = cancelManager.cancelLogin();
    assert.equal(canceled.status, 'canceled');
    const completion = await started.completion;
    assert.equal(completion.status, 'canceled');

    // Loopback server should no longer accept connections
    await assert.rejects(() => fetch(started.redirectUri));
  } finally {
    cancelManager.dispose();
  }

  // 2. Timeout closes loopback server and transitions to error(TIMEOUT)
  const timeoutManager = new DesktopAuthHandoffManager({
    studioOrigin: 'https://motion.open-design.ai',
    openExternal: () => {},
    exchangeFetch: async () => {
      throw new Error('should not be called');
    },
    timeoutMs: 60,
  });
  try {
    const started = await timeoutManager.startLogin();
    const finalState = await started.completion;
    assert.equal(finalState.status, 'error');
    assert.equal(finalState.errorCode, 'TIMEOUT');
    await assert.rejects(() => fetch(started.redirectUri));
  } finally {
    timeoutManager.dispose();
  }

  // 3. Exchange HTTP error transitions cleanly to error(EXCHANGE_FAILED)
  const failCloud = await startStubServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'expired_code' }));
  });
  const failManager = new DesktopAuthHandoffManager({
    studioOrigin: failCloud.origin,
    openExternal: () => {},
    exchangeFetch: (url, init) => fetch(url, init),
    timeoutMs: 10_000,
  });
  try {
    const started = await failManager.startLogin();
    const cb = new URL(started.redirectUri);
    cb.searchParams.set('code', 'expired_handoff_code');
    cb.searchParams.set('state', started.state);
    const cbRes = await fetch(cb);
    assert.equal(cbRes.status, 200);
    const finalState = await started.completion;
    assert.equal(finalState.status, 'error');
    assert.equal(finalState.errorCode, 'EXCHANGE_FAILED');
  } finally {
    failManager.dispose();
    await failCloud.close();
  }
});

test('R5 data directory layout persists formatVersion, creates managed subdirs, and never touches legacy workspace-data', () => {
  const userDataDir = makeTempDir('om-data-layout');
  const legacyWorkspaceDir = path.join(userDataDir, 'workspace-data');
  const legacyFile = path.join(legacyWorkspaceDir, 'legacy-project.json');

  try {
    // Seed legacy workspace-data/ before initializing thin-shell layout
    mkdirSync(legacyWorkspaceDir, { recursive: true });
    writeFileSync(legacyFile, '{"legacy":true}\n', 'utf8');

    const t1 = new Date('2026-11-23T10:00:00.000Z');
    const first = ensureDesktopDataLayout(userDataDir, { now: () => t1 });
    assert.equal(first.created, true);
    assert.equal(first.upgraded, false);
    assert.equal(first.metadata.formatVersion, DESKTOP_DATA_LAYOUT_VERSION);
    assert.equal(first.metadata.appId, DESKTOP_APP_ID);
    assert.equal(first.metadata.createdAt, t1.toISOString());
    assert.equal(first.metadata.updatedAt, t1.toISOString());

    for (const subdir of DESKTOP_DATA_SUBDIRS) {
      assert.equal(existsSync(path.join(userDataDir, subdir)), true, `Missing subdir ${subdir}`);
    }

    const stored = readDesktopDataLayoutMetadata(userDataDir);
    assert.deepEqual(stored, first.metadata);

    // Re-running preserves createdAt and updates updatedAt
    const t2 = new Date('2026-11-23T11:30:00.000Z');
    const second = ensureDesktopDataLayout(userDataDir, { now: () => t2 });
    assert.equal(second.created, false);
    assert.equal(second.upgraded, false);
    assert.equal(second.metadata.createdAt, t1.toISOString());
    assert.equal(second.metadata.updatedAt, t2.toISOString());

    // Legacy workspace-data/ remains completely untouched
    assert.equal(existsSync(legacyFile), true);
    assert.equal(readFileSync(legacyFile, 'utf8'), '{"legacy":true}\n');

    // Subpath helper allows in-bounds paths and rejects traversal into workspace-data
    const configFile = resolveLayoutSubpath(first.paths, 'config', 'signed-config.json');
    assert.equal(configFile, path.join(first.paths.configDir, 'signed-config.json'));
    assert.throws(() => resolveLayoutSubpath(first.paths, 'config', '..', 'workspace-data', 'legacy-project.json'));

    // Newer unsupported formatVersion throws DesktopDataLayoutVersionError without overwriting
    writeFileSync(
      first.paths.layoutFile,
      JSON.stringify({
        formatVersion: DESKTOP_DATA_LAYOUT_VERSION + 5,
        appId: DESKTOP_APP_ID,
        createdAt: t1.toISOString(),
        updatedAt: t2.toISOString(),
      }),
      'utf8',
    );
    assert.throws(
      () => ensureDesktopDataLayout(userDataDir),
      err => err instanceof DesktopDataLayoutVersionError && err.foundVersion === DESKTOP_DATA_LAYOUT_VERSION + 5,
    );
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('R5 openmotion:// protocol parsing validates safe deep links, rejects untrusted input, and routes open events', () => {
  // Basic openmotion://open
  const openRes = parseDesktopDeepLink('openmotion://open');
  assert.equal(openRes.ok, true);
  assert.equal(openRes.scheme, DESKTOP_PROTOCOL_SCHEME);
  assert.equal(openRes.action, 'open');
  assert.deepEqual(openRes.params, {});
  assert.equal(openRes.normalizedUrl, 'openmotion://open');

  // Case-insensitive host + allowlisted safe params
  const openWithParams = parseDesktopDeepLink(
    'OPENMOTION://OPEN/?source=web-handoff&path=/workflows/video&tab=projects',
  );
  assert.equal(openWithParams.ok, true);
  assert.equal(openWithParams.action, 'open');
  assert.deepEqual(openWithParams.params, {
    source: 'web-handoff',
    path: '/workflows/video',
    tab: 'projects',
  });

  // Malformed URLs, wrong schemes, credentials/ports, unsupported actions, and untrusted parameters are rejected
  const invalidCases = [
    ['', 'empty'],
    ['not a url', 'malformed-url'],
    ['https://motion.open-design.ai/open', 'invalid-scheme'],
    ['javascript:alert(1)', 'invalid-scheme'],
    ['openmotion://user:pass@open', 'disallowed-credentials-or-port'],
    ['openmotion://open:8080', 'disallowed-credentials-or-port'],
    ['openmotion://open#frag', 'untrusted-parameter'],
    ['openmotion://exec?cmd=whoami', 'unsupported-action'],
    ['openmotion://open/extra', 'unsupported-action'],
    ['openmotion://open?token=secret123', 'untrusted-parameter'],
    ['openmotion://open?url=https://evil.example', 'untrusted-parameter'],
    ['openmotion://open?source=a&source=b', 'untrusted-parameter'],
    ['openmotion://open?path=/../etc/passwd', 'invalid-parameter-value'],
    ['openmotion://open?path=https://evil.example', 'invalid-parameter-value'],
    ['openmotion://open?source=bad%20space', 'invalid-parameter-value'],
    ['openmotion://open\r\nInjected: 1', 'control-chars'],
    [`openmotion://open?source=${'a'.repeat(2100)}`, 'too-long'],
  ];

  for (const [raw, expectedReason] of invalidCases) {
    const parsed = parseDesktopDeepLink(raw);
    assert.equal(parsed.ok, false, `Expected rejection for ${raw}`);
    assert.equal(parsed.reason, expectedReason, `Unexpected reject reason for ${raw}`);
  }

  // Router dispatches openmotion://open, records safe events, and skips rejected URLs
  const activated = [];
  const rejected = [];
  const router = new DesktopProtocolRouter({
    onActivateMainWindow: link => activated.push(link),
    onRejected: (rej, raw) => rejected.push({ reason: rej.reason, raw }),
    maxRecordedEvents: 2,
  });

  assert.equal(
    extractDeepLinkFromArgv(['/app/OpenDesign', '--flag', 'openmotion://open?source=cli']),
    'openmotion://open?source=cli',
  );
  assert.equal(extractDeepLinkFromArgv(['/app/OpenDesign', 'https://example.com']), null);

  router.handleArgv(['/app/OpenDesign', 'openmotion://open?source=cli']);
  router.handleUrl('openmotion://open?token=forbidden');
  router.handleUrl('openmotion://open?source=browser');
  router.handleUrl('openmotion://open?source=third');

  assert.equal(activated.length, 3);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'untrusted-parameter');
  // Ring buffer retains only the latest 2 valid events
  const recorded = router.getRecordedEvents();
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].params.source, 'browser');
  assert.equal(recorded[1].params.source, 'third');

  // Protocol client registration (packaged and defaultApp modes)
  const calls = [];
  const fakeApp = {
    setAsDefaultProtocolClient: (...args) => {
      calls.push(args);
      return true;
    },
  };
  const packagedReg = registerDesktopProtocolClient(fakeApp, { defaultApp: false });
  assert.deepEqual(packagedReg, { registered: true, scheme: DESKTOP_PROTOCOL_SCHEME });
  assert.deepEqual(calls[0], [DESKTOP_PROTOCOL_SCHEME]);

  const devReg = registerDesktopProtocolClient(fakeApp, {
    defaultApp: true,
    execPath: '/usr/local/bin/electron',
    argv: ['/usr/local/bin/electron', 'dist/main.mjs'],
  });
  assert.deepEqual(devReg, { registered: true, scheme: DESKTOP_PROTOCOL_SCHEME });
  assert.equal(calls[1][0], DESKTOP_PROTOCOL_SCHEME);
  assert.equal(calls[1][1], '/usr/local/bin/electron');
  assert.deepEqual(calls[1][2], [path.resolve('dist/main.mjs')]);
});

test('K1/K2 retry.html is self-contained, supports light/dark themes without backdrop-filter, and wires minimal local-page bridge actions', () => {
  const retryHtml = readFileSync(path.join(desktopRoot, 'src', 'retry.html'), 'utf8');
  assert.match(retryHtml, /prefers-color-scheme:\s*dark/);
  assert.equal(/backdrop-filter/i.test(retryHtml), false, 'retry.html must not use frosted glass / backdrop-filter');
  assert.equal(/<(?:script|link)\b[^>]+https?:\/\//i.test(retryHtml), false, 'retry.html must be self-contained');
  assert.match(retryHtml, /id="retry-btn"/);
  assert.match(retryHtml, /id="export-diagnostics-btn"/);
  assert.match(retryHtml, /__OPENMOTION_LOCAL_PAGE__\?\.retryStartup/);
  assert.match(retryHtml, /__OPENMOTION_LOCAL_PAGE__\?\.exportDiagnostics/);
  assert.match(retryHtml, /'diagnostics',\s*'exportBundle'/);
  assert.equal(retryHtml.includes('innerHTML'), false, 'retry.html should never use innerHTML for error text');
});

test('K2 in-window auth fallback permits allowlisted accounts.open-design.ai OIDC redirects while keeping /billing external', () => {
  const config = {
    studioOrigin: 'https://motion.open-design.ai',
    channel: 'stable',
    windowPolicy: {
      allowedPopupOrigins: ['https://motion.open-design.ai'],
      allowedAuthOrigins: ['https://motion.open-design.ai', 'https://accounts.open-design.ai'],
      allowBlankPopups: true,
    },
    inWindowAuthFallbackActive: true,
  };

  const authRedirect = evaluateNavigationPolicy('https://accounts.open-design.ai/oauth/authorize?client_id=om', config);
  assert.equal(authRedirect.action, 'allow');
  assert.equal(authRedirect.reason, 'auth-fallback-origin');

  const billingOnAccountHost = evaluateNavigationPolicy('https://accounts.open-design.ai/billing', config);
  assert.equal(billingOnAccountHost.action, 'deny');
  assert.equal(billingOnAccountHost.reason, 'billing-external');
  assert.equal(billingOnAccountHost.openExternal, true);

  const outsideFallback = evaluateNavigationPolicy('https://accounts.open-design.ai/profile', {
    ...config,
    inWindowAuthFallbackActive: false,
  });
  assert.equal(outsideFallback.action, 'deny');
  assert.equal(outsideFallback.reason, 'billing-external');
  assert.equal(outsideFallback.openExternal, true);
});

test('K3 DesktopAuthHandoffManager resolves studioOrigin dynamically after signed config domain migration', async () => {
  let currentOrigin = 'https://motion.open-design.ai';
  let openedUrl = '';
  const manager = new DesktopAuthHandoffManager({
    getStudioOrigin: () => currentOrigin,
    openExternal: url => {
      openedUrl = url;
    },
    exchangeFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });

  assert.equal(manager.openInWindowFallback(), 'https://motion.open-design.ai/auth/login');
  currentOrigin = 'https://studio.open-design.ai';
  assert.equal(manager.openInWindowFallback(), 'https://studio.open-design.ai/auth/login');

  const started = await manager.startLogin();
  assert.ok(openedUrl.startsWith('https://studio.open-design.ai/auth/desktop/start?'));
  assert.equal(started.startUrl, openedUrl);
  manager.cancelLogin();
});

test('K2 billing query params stay external during auth fallback and privileged IPC is denied on /auth/* or during fallback', () => {
  const policyConfig = {
    studioOrigin: 'https://motion.open-design.ai',
    channel: 'stable',
    windowPolicy: {
      allowedPopupOrigins: ['https://motion.open-design.ai'],
      allowedAuthOrigins: ['https://motion.open-design.ai', 'https://accounts.open-design.ai'],
      allowBlankPopups: true,
    },
    inWindowAuthFallbackActive: true,
  };

  for (const billingQueryUrl of [
    'https://motion.open-design.ai/settings?billing=plan',
    'https://accounts.open-design.ai/account?checkout=pro',
    'https://motion.open-design.ai/home?upgrade=1',
  ]) {
    const decision = evaluateNavigationPolicy(billingQueryUrl, policyConfig);
    assert.equal(decision.action, 'deny', billingQueryUrl);
    assert.equal(decision.openExternal, true, billingQueryUrl);
    assert.equal(decision.isBillingOrAccountPortal, true, billingQueryUrl);
  }

  const authFrame = { url: 'https://motion.open-design.ai/auth/login', parent: null };
  const authWin = { webContents: { id: 42, mainFrame: authFrame } };
  assert.equal(
    authorizePrivilegedIpcSender(
      { sender: authWin.webContents, senderFrame: authFrame },
      { mainWindow: authWin, studioOrigin: 'https://motion.open-design.ai', channel: 'stable' },
    ).ok,
    false,
  );

  const studioFrame = { url: 'https://motion.open-design.ai/mcp-setup', parent: null };
  const studioWin = { webContents: { id: 43, mainFrame: studioFrame } };
  assert.equal(
    authorizePrivilegedIpcSender(
      { sender: studioWin.webContents, senderFrame: studioFrame },
      {
        mainWindow: studioWin,
        studioOrigin: 'https://motion.open-design.ai',
        channel: 'stable',
        inWindowAuthFallbackActive: true,
      },
    ).ok,
    false,
  );
  assert.equal(
    authorizePrivilegedIpcSender(
      { sender: studioWin.webContents, senderFrame: studioFrame },
      {
        mainWindow: studioWin,
        studioOrigin: 'https://motion.open-design.ai',
        channel: 'stable',
        inWindowAuthFallbackActive: false,
      },
    ).ok,
    true,
  );
});

test('K10 resolvePackagedReleaseChannel preserves packaged test channel and ignores env overrides when packaged', () => {
  assert.equal(
    resolvePackagedReleaseChannel({
      isPackaged: true,
      version: '0.2.1',
      packageChannel: 'stable',
      envChannel: 'test',
    }),
    'stable',
  );
  assert.equal(
    resolvePackagedReleaseChannel({
      isPackaged: true,
      version: '0.2.1',
      packageChannel: 'test',
      envChannel: 'stable',
    }),
    'test',
  );
  assert.equal(
    resolvePackagedReleaseChannel({
      isPackaged: true,
      version: '0.2.1',
      appUpdateYmlContent: 'provider: generic\nurl: https://releases.open-design.ai/desktop/test/mac-arm64/\n',
    }),
    'test',
  );
  assert.equal(
    resolvePackagedReleaseChannel({
      isPackaged: true,
      version: '0.2.1-beta.1',
    }),
    'test',
  );
  assert.equal(
    resolvePackagedReleaseChannel({
      isPackaged: false,
      version: '0.2.1',
      packageChannel: 'stable',
      envChannel: 'test',
    }),
    'test',
  );
});

test('K3 login chain helpers: parseStudioAuthNavigationUrl, probeDesktopHandoffSupport, and openInWindowFallback', async () => {
  const studioOrigin = DEFAULT_STUDIO_URLS.test;
  assert.deepEqual(
    parseStudioAuthNavigationUrl(
      `${studioOrigin}/auth/login?switch=1&returnTo=%2Fprojects%2Fabc`,
      studioOrigin,
    ),
    { returnPath: '/projects/abc', switchAccount: true },
  );
  assert.deepEqual(
    parseStudioAuthNavigationUrl(
      `${studioOrigin}/auth/login?returnTo=//evil.example.com/phish`,
      studioOrigin,
    ),
    { switchAccount: false },
  );
  assert.equal(sanitizeAuthReturnPath('/auth/login'), undefined);
  assert.equal(sanitizeAuthReturnPath('/\\evil.example'), undefined);
  assert.equal(sanitizeAuthReturnPath('/%5cevil.example/ok'), '/%5cevil.example/ok');
  assert.equal(sanitizeAuthReturnPath('/explore?tab=1'), '/explore?tab=1');
  assert.equal(
    parseStudioAuthNavigationUrl('https://evil.example.com/auth/login', studioOrigin),
    null,
  );
  assert.equal(
    parseStudioAuthNavigationUrl(`${studioOrigin}/explore`, studioOrigin),
    null,
  );

  // Probe returns false on 404/405/501 (legacy backend without /auth/desktop/start) and true on 400 (mounted route).
  assert.equal(
    await probeDesktopHandoffSupport(studioOrigin, async () => ({ status: 404 })),
    false,
  );
  assert.equal(
    await probeDesktopHandoffSupport(studioOrigin, async () => ({ status: 400 })),
    true,
  );
  assert.equal(
    await probeDesktopHandoffSupport(studioOrigin, async () => {
      throw new Error('network timeout');
    }),
    true,
  );

  let receivedCredentials = '';
  const manager = new DesktopAuthHandoffManager({
    studioOrigin,
    openExternal: () => {},
    exchangeFetch: async (_url, init) => {
      receivedCredentials = init.credentials ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          user: { id: 'u-1', email: 'test@example.com' },
          workspaceId: 'ws-1',
        }),
      };
    },
  });

  const fallbackUrl = manager.openInWindowFallback({ returnPath: '/explore', switchAccount: true });
  assert.equal(
    fallbackUrl,
    `${studioOrigin}/auth/login?switch=1&returnTo=%2Fexplore`,
  );

  const started = await manager.startLogin();
  const callbackUrl = new URL(started.redirectUri);
  callbackUrl.searchParams.set('code', 'test-code-12345678');
  callbackUrl.searchParams.set('state', started.state);
  const res = await fetch(callbackUrl.toString());
  assert.equal(res.status, 200);
  const finalState = await started.completion;
  assert.equal(finalState.status, 'authenticated');
  assert.equal(receivedCredentials, 'include');

  // Overlapping startLogin() calls reserve ownership before awaiting loopback bind:
  // after cancelLogin(), neither superseded nor canceled callbacks can authenticate.
  let exchangeCallsAfterCancel = 0;
  const raceManager = new DesktopAuthHandoffManager({
    studioOrigin,
    openExternal: () => {},
    exchangeFetch: async () => {
      exchangeCallsAfterCancel += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, user: { id: 'u-race' }, workspaceId: 'ws-race' }),
      };
    },
  });
  const [firstAttempt, secondAttempt] = await Promise.all([
    raceManager.startLogin(),
    raceManager.startLogin(),
  ]);
  raceManager.cancelLogin();
  for (const attempt of [firstAttempt, secondAttempt]) {
    const cb = new URL(attempt.redirectUri);
    cb.searchParams.set('code', 'late-code-12345678');
    cb.searchParams.set('state', attempt.state);
    try {
      const cbRes = await fetch(cb.toString());
      assert.notEqual(cbRes.status, 200);
    } catch {
      // Expected: loopback server already closed cleanly.
    }
  }
  assert.equal(exchangeCallsAfterCancel, 0);
  assert.equal(raceManager.getState().status, 'canceled');
  raceManager.dispose();
  manager.dispose();
});

test('K2 resolveDefaultFallbackAuthOrigins allows test OIDC origins only while inWindowAuthFallbackActive is true', () => {
  const testOrigins = resolveDefaultFallbackAuthOrigins('test');
  const stableOrigins = resolveDefaultFallbackAuthOrigins('stable');
  const testVelaApiOrigin = `https://${'vela-api.powerformer.net'}`;
  const testPortalOrigin = `https://${'open-design.powerformer.net'}`;

  assert.equal(testOrigins.includes(testVelaApiOrigin), true);
  assert.equal(testOrigins.includes(testPortalOrigin), true);
  assert.equal(stableOrigins.includes(testVelaApiOrigin), false);
  assert.equal(stableOrigins.includes('https://accounts.open-design.ai'), true);

  const baseConfig = {
    studioOrigin: DEFAULT_STUDIO_URLS.test,
    channel: 'test',
    explicitIdpAuthOrigins: testOrigins,
  };

  assert.equal(
    evaluateNavigationPolicy(`${testVelaApiOrigin}/api/auth/oauth2/authorize`, {
      ...baseConfig,
      inWindowAuthFallbackActive: false,
    }).action,
    'deny',
  );

  assert.equal(
    evaluateNavigationPolicy(`${testVelaApiOrigin}/api/auth/oauth2/authorize`, {
      ...baseConfig,
      inWindowAuthFallbackActive: true,
    }).action,
    'allow',
  );
  assert.equal(
    evaluateNavigationPolicy(`${testPortalOrigin}/cloud/login?client_id=openmotion-web`, {
      ...baseConfig,
      inWindowAuthFallbackActive: true,
    }).action,
    'allow',
  );

  const billingDecision = evaluateNavigationPolicy(`${testPortalOrigin}/billing/plans`, {
    ...baseConfig,
    inWindowAuthFallbackActive: true,
  });
  assert.equal(billingDecision.action, 'deny');
  assert.equal(billingDecision.reason, 'billing-external');
});

test('K3 account.startBrowserLogin parses switch=1 from loginUrl and returns structuredClone-safe payload', async () => {
  const receivedCalls = [];
  const registry = new CapabilityRegistry();
  registry.register(
    createAccountCapabilityModule({
      startSignIn: async params => {
        receivedCalls.push(params);
        return {
          mode: 'browser-handoff',
          url: `${DEFAULT_STUDIO_URLS.test}/auth/desktop/start?state=abc`,
          startUrl: `${DEFAULT_STUDIO_URLS.test}/auth/desktop/start?state=abc`,
          redirectUri: 'http://127.0.0.1:43210/callback',
          state: 'abc',
          codeChallenge: 'xyz',
        };
      },
      cancelSignIn: () => ({ status: 'canceled' }),
      refreshAccount: () => ({ status: 'idle' }),
    }),
  );

  const result = await registry.invoke('account', 'startBrowserLogin', {
    loginUrl: '/auth/login?switch=1&returnTo=%2Fsettings',
    returnTo: '/settings',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(receivedCalls, [{ returnPath: '/settings', switchAccount: true }]);
  assert.deepEqual(structuredClone(result), result);
});
