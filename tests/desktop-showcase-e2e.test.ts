/**
 * End-to-End Desktop Cloud Shell & Web Connect Script Showcase Chain Test.
 *
 * Exercises the full production showcase chain across all layers:
 * 1. Two-tier Ed25519 signed config (Root -> Daily Cert -> Envelope) + dynamic
 *    studioUrl domain migration (`motion.open-design.ai` -> `studio.open-design.ai`)
 *    without shell restart, plus default `allowBlankPopups: true` and window policy.
 * 2. Real Cloud Desktop Auth Handoff (`createDesktopHandoffRoutes` Hono app +
 *    `DesktopAuthHandoffManager` PKCE S256 + ephemeral 127.0.0.1 loopback +
 *    dynamic studioOrigin + real `Set-Cookie: om_session=...` + single-use replay 401),
 *    in-window auth fallback policy (`accounts.open-design.ai` allowed, `/billing` &
 *    `?billing=` external, privileged IPC denied), and built `desktop/dist/preload.cjs`
 *    smoke verification for Studio vs `file://` retry page bridges.
 * 3. Real local Agent shims (`codex`, `claude`, standalone `murmur`) on disk:
 *    - `atom.detect` parses real `murmur status --json` schema 1 even when `murmur`
 *      exits non-zero in signed-out state (`signed_in: false`, `engine.served_by`).
 *    - `atom.exec` rejects renderer-supplied `mcpUrl` overrides (even within
 *      `*.open-design.ai`) and injects the shell's dynamic `expectedMcpUrl`.
 *    - Claude Code conflict with `conflictPolicy: 'replace'` runs `claude mcp remove`
 *      BEFORE `claude mcp add` (required on real Claude Code >= 2.1.330).
 *    - `atom.config` surgical read/write, shell-enforced `mcpUrl`, legacy stdio conflict
 *      detection, and `restoreBackup` feature authorization + verbatim recovery.
 * 4. Murmur engine component lifecycle:
 *    - macOS Apple Developer ID designated requirement builder & verifier fail-closed check.
 *    - Reusing pre-existing standalone `~/.murmurant/bin/murmur` without overwriting,
 *      and installing fresh into unified `~/.murmurant/bin/murmur` (M5) with surgical
 *      uninstall preserving sibling files.
 * 5. `atom.credential` runtime key lifecycle:
 *    - Device auth start -> poll -> encrypted store -> stdin-only inject via real
 *      `murmur magpie provider add opendesign url=... list=off --api-key-stdin`.
 *    - Failed remote revoke purges local secret and retains `pending_revoke` record.
 *    - Cross-account isolation blocks Account B from revoking or retrying Account A's
 *      pending revoke; Account A retry sends `Authorization: Bearer ...` and succeeds.
 * 6. `minShellVersion` enforcement rejects outdated shells BEFORE prompting user.
 * 7. Full Web Connect Script (`--serve` + `--connect` CLI) loopback HTTP + SSE
 *    `/v1/events` stream + `/mcp-setup#connect_port=...&connect_token=...` pairing URL
 *    + `atom.detect` round-trip over 127.0.0.1.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';
import { Hono } from 'hono';
import {
  buildStudioPairingUrl,
  runConnectCli,
  startConnectScriptServer,
} from '../packages/connect-script/index.ts';
import {
  buildMacOsDeveloperIdRequirement,
  createLocalAtomsRuntime,
  createMemorySecretStore,
  defaultCodeSignatureVerifier,
  getUnifiedMurmurBinaryPath,
} from '../packages/local-atoms/index.ts';
import {
  createBundledDefaultConfigPayload,
  generateEd25519KeyPair,
  signConfigEnvelope,
  signDailyCertificate,
  SignedConfigManager,
} from '../packages/signed-config/index.ts';
import { HOST_CAPABILITIES } from '../shared/desktop-contract.ts';
import { MURMUR_COMMAND_TEMPLATES, MURMUR_COMPONENT_ID } from '../shared/engine-command-contract.ts';
import type { SignedConfigPayload } from '../shared/signed-config.ts';
import { createDesktopHandoffRoutes } from '../src/auth/desktop-handoff.ts';
import {
  createBrowserSession,
  InMemoryAuthCache,
  InMemoryAuthStore,
  SESSION_COOKIE_NAME,
  type AuthEnv,
} from '../src/auth/index.ts';
import { parseConfig } from '../src/infra/config.ts';
import { DesktopAuthHandoffManager } from '../desktop/src/auth-handoff.ts';
import { authorizePrivilegedIpcSender, authorizeSplashSender } from '../desktop/src/ipc-guard.ts';
import { evaluateNavigationPolicy, evaluateWindowOpenPolicy } from '../desktop/src/window-policy.ts';
import { resolveConnectBridge } from '../scripts/connect-local-agent.mjs';

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExecutableScript(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o755 });
  chmodSync(filePath, 0o755);
}

function evaluateBuiltPreloadBundle(
  preloadBundlePath: string,
  locationHref: string,
  options?: { isSubframe?: boolean },
): Record<string, unknown> {
  const exposed: Record<string, unknown> = {};
  const bundleSource = readFileSync(preloadBundlePath, 'utf8');
  const nodeRequire = createRequire(preloadBundlePath);
  const parsed = new URL(locationHref);
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld(key: string, api: unknown) {
        exposed[key] = api;
      },
    },
    ipcRenderer: {
      invoke: async () => ({ ok: true }),
      send: () => {},
      on: () => {},
      removeListener: () => {},
    },
  };
  const fakeWindow: Record<string, unknown> = {
    location: {
      href: parsed.href,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
    },
    addEventListener: () => {},
  };
  fakeWindow.self = fakeWindow;
  fakeWindow.top = options?.isSubframe ? {} : fakeWindow;
  const sandbox = {
    require: (id: string) => (id === 'electron' ? fakeElectron : nodeRequire(id)),
    module: { exports: {} },
    exports: {},
    process,
    Buffer,
    URL,
    URLSearchParams,
    console,
    window: fakeWindow,
    globalThis: undefined as unknown,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(bundleSource, sandbox, { filename: preloadBundlePath });
  return exposed;
}

test('Showcase E2E: full chain from signed config migration & real Hono PKCE handoff through all 5 local atoms, preload smoke, and Web Connect Script CLI + SSE', async () => {
  const rootTmp = makeTempDir('om-showcase-e2e-');
  const dataDir = path.join(rootTmp, 'data');
  const homeDir = path.join(rootTmp, 'home');
  const binDir = path.join(rootTmp, 'bin');
  const commandLogPath = path.join(rootTmp, 'commands.jsonl');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const nodeBin = process.execPath;
  let authHandoff: DesktopAuthHandoffManager | null = null;

  try {
    // -----------------------------------------------------------------------
    // Step 1: Build real executable CLI shims (codex, claude, standalone murmur)
    // -----------------------------------------------------------------------
    const codexBin = path.join(binDir, 'codex');
    writeExecutableScript(
      codexBin,
      `#!${nodeBin}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify({ cmd: 'codex', args }) + '\\n');
if (args[0] === '--version') {
  console.log('codex-cli 0.169.1');
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'add') {
  const name = args[2];
  const urlIdx = args.indexOf('--url');
  const url = urlIdx >= 0 ? args[urlIdx + 1] : '';
  const targetHome = process.env.OM_TEST_HOME || ${JSON.stringify(homeDir)};
  const cfgPath = path.join(targetHome, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, '[mcp_servers.' + name + ']\\nurl = "' + url + '"\\n', 'utf8');
  console.log('Added ' + name);
  process.exit(0);
}
process.exit(0);
`,
    );

    // Claude Code shim simulates REAL Claude Code 2.1.330 behavior:
    // `claude mcp add` REJECTS an existing entry unless `claude mcp remove` ran first!
    const claudeBin = path.join(binDir, 'claude');
    writeExecutableScript(
      claudeBin,
      `#!${nodeBin}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify({ cmd: 'claude', args }) + '\\n');
if (args[0] === '--version') {
  console.log('2.1.330 (Claude Code)');
  process.exit(0);
}
const cfgPath = path.join(${JSON.stringify(homeDir)}, '.claude.json');
const loadCfg = () => (fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {});
const saveCfg = (obj) => fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2) + '\\n', 'utf8');

if (args[0] === 'mcp' && args[1] === 'remove') {
  const name = args[args.length - 1];
  const cfg = loadCfg();
  if (cfg.mcpServers && name in cfg.mcpServers) {
    delete cfg.mcpServers[name];
    saveCfg(cfg);
  }
  console.log('Removed ' + name);
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'add') {
  const name = args[args.length - 2];
  const url = args[args.length - 1];
  const cfg = loadCfg();
  cfg.mcpServers = cfg.mcpServers || {};
  if (name in cfg.mcpServers) {
    console.error('Error: MCP server "' + name + '" already exists');
    process.exit(1);
  }
  cfg.mcpServers[name] = { type: 'http', url };
  saveCfg(cfg);
  console.log('Added ' + name);
  process.exit(0);
}
process.exit(0);
`,
    );

    // Seed an existing conflicting Claude Code entry so replace flow is exercised for real!
    writeFileSync(
      path.join(homeDir, '.claude.json'),
      JSON.stringify(
        {
          mcpServers: {
            openmotion: { type: 'http', url: 'https://old.open-design.ai/mcp' },
            sibling: { type: 'http', url: 'https://other.example/mcp' },
          },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    // Standalone Murmur shim at `~/.murmurant/bin/murmur` simulating REAL murmurant contract:
    // - `murmur status --json` prints valid schema 1 JSON AND exits 1 when signed_in === false!
    // - `murmur magpie provider add opendesign url=... list=off --api-key-stdin` reads key from stdin.
    const standaloneMurmurPath = getUnifiedMurmurBinaryPath(homeDir, 'darwin');
    writeExecutableScript(
      standaloneMurmurPath,
      `#!${nodeBin}
const fs = require('node:fs');
const args = process.argv.slice(2);
const stdinData = args.includes('--api-key-stdin') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(
  ${JSON.stringify(commandLogPath)},
  JSON.stringify({
    cmd: 'murmur',
    args,
    menubarEnv: process.env.MURMUR_MENUBAR || null,
    stdinLen: stdinData.length,
    stdinHasSecret: stdinData.trim().startsWith('od_rt_'),
  }) + '\\n',
);
if (args[0] === 'version') {
  console.log('murmur 0.9.4');
  process.exit(0);
}
if (args[0] === 'status' && args[1] === '--json') {
  console.log(JSON.stringify({
    schema: 1,
    generated_at: '2026-11-23T08:00:00Z',
    signed_in: false,
    engine: { served_by: 'personal', running: true, release: '0.9.4' },
    mode: { current: 'personal', derived: false },
    agents: [{ id: 'codex', name: 'Codex', wired: true, route: 'engine' }],
    attention: [{ kind: 'signed_out', action: 'login' }],
  }));
  // Real murmurant behavior: signed-out status exits non-zero while printing valid JSON!
  process.exit(1);
}
if (args[0] === 'magpie' && args[1] === 'provider' && args[2] === 'add') {
  if (!stdinData.trim()) {
    console.error('missing key on stdin');
    process.exit(1);
  }
  console.log('provider added ' + args[3] + ' echo=' + stdinData.trim());
  process.exit(0);
}
process.exit(0);
`,
    );

    // -----------------------------------------------------------------------
    // Step 2: Two-tier Ed25519 signed config + domain migration without restart
    //         + Real Hono Cloud Desktop Auth Handoff + Preload bundle smoke
    // -----------------------------------------------------------------------
    const bundledDefault = createBundledDefaultConfigPayload('stable');
    assert.equal(
      bundledDefault.windowPolicy?.allowBlankPopups,
      true,
      'Bundled default must allow about:blank popups for Studio preview/presenter views',
    );
    const blankPopupDecision = evaluateWindowOpenPolicy('about:blank', {
      studioOrigin: 'https://motion.open-design.ai',
      channel: 'stable',
      windowPolicy: bundledDefault.windowPolicy,
    });
    assert.equal(blankPopupDecision.action, 'allow');
    assert.equal(blankPopupDecision.overrideBrowserWindowOptions.webPreferences.preload, undefined);

    const rootKeys = generateEd25519KeyPair();
    const dailyKeys = generateEd25519KeyPair();
    const nowIso = '2026-11-23T08:00:00.000Z';
    const dailyCert = signDailyCertificate({
      keyId: 'daily-2026-11-23',
      publicKeySpkiBase64: dailyKeys.publicKeySpkiBase64,
      notBefore: '2026-11-22T00:00:00.000Z',
      notAfter: '2026-11-25T00:00:00.000Z',
      rootPrivateKey: rootKeys.privateKey,
    });

    const murmurBinaryBytes = Buffer.from('#!/bin/sh\necho murmur\n');
    const murmurSha256 = createHash('sha256').update(murmurBinaryBytes).digest('hex');

    const migratedPayload: SignedConfigPayload = {
      ...bundledDefault,
      studioUrl: 'https://studio.open-design.ai',
      allowedOrigins: ['https://studio.open-design.ai'],
      windowPolicy: {
        allowedPopupOrigins: ['https://studio.open-design.ai'],
        allowedAuthOrigins: ['https://studio.open-design.ai', 'https://accounts.open-design.ai'],
        allowBlankPopups: true,
      },
      components: {
        [MURMUR_COMPONENT_ID]: {
          componentId: MURMUR_COMPONENT_ID,
          displayName: 'Murmur Local Engine',
          minVersion: '0.9.4',
          platforms: {
            'darwin-arm64': {
              url: 'https://releases.open-design.ai/murmur/0.9.4/murmur-darwin-arm64',
              sha256: murmurSha256,
              publisherId: 'powerformer-murmur',
            },
          },
        },
      },
      firstPartyCommands: {
        [MURMUR_COMMAND_TEMPLATES.PROVIDER_UPSERT.templateId]: {
          templateId: MURMUR_COMMAND_TEMPLATES.PROVIDER_UPSERT.templateId,
          componentId: MURMUR_COMPONENT_ID,
          mutating: true,
          stdinSecret: true,
          argv: [...MURMUR_COMMAND_TEMPLATES.PROVIDER_UPSERT.argv],
          params: {
            providerId: { type: 'identifier', required: true },
            providerUrl: { type: 'url_in_domain_scope', required: true },
          },
        },
      },
      credentials: {
        opendesign_runtime: {
          credentialId: 'opendesign_runtime',
          displayName: 'OpenDesign Runtime Key',
          issuerUrl: 'https://studio.open-design.ai',
          deviceAuthPath: '/auth/device/start',
          tokenPath: '/auth/device/token',
          revokePath: '/auth/device/revoke',
          targetComponentId: MURMUR_COMPONENT_ID,
        },
      },
      features: {
        ...bundledDefault.features,
        murmur_gateway: {
          featureId: 'murmur_gateway',
          version: '1.0.0',
          title: 'Local Model Gateway',
          summary: 'Configure OpenDesign runtime key for local Murmur engine.',
          minShellVersion: '0.2.0',
          commandTemplateIds: [MURMUR_COMMAND_TEMPLATES.PROVIDER_UPSERT.templateId],
          componentIds: [MURMUR_COMPONENT_ID],
          credentialIds: ['opendesign_runtime'],
        },
        future_feature: {
          featureId: 'future_feature',
          version: '1.0.0',
          title: 'Future Shell Feature',
          summary: 'Requires a newer desktop shell version.',
          minShellVersion: '0.9.0',
          commandTemplateIds: ['codex.mcp.add_remote'],
        },
      },
    };

    const signedConfig = new SignedConfigManager({
      dataDir,
      channel: 'stable',
      rootPublicKey: rootKeys.publicKey,
      now: () => Date.parse(nowIso),
    });

    const resolveStudioOrigin = () => new URL(signedConfig.getActiveConfig().studioUrl!).origin;

    // Mount REAL cloud Hono desktop handoff routes with a real seeded browser session!
    const cloudConfig = parseConfig({
      NODE_ENV: 'test',
      WORKER_ROLE: 'api',
      APP_PUBLIC_ORIGIN: 'https://studio.open-design.ai',
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: 'https://accounts.open-design.ai',
      OIDC_CLIENT_ID: 'openmotion-cloud-client',
      OIDC_CLIENT_SECRET: 'ephemeral-test-client-secret',
      SESSION_SECRET: 's'.repeat(32),
      MODEL_GATEWAY_MODE: 'mock',
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
      REDIS_URL: 'redis://127.0.0.1:6379',
    });
    const authStore = new InMemoryAuthStore();
    const authCache = new InMemoryAuthCache();
    const seeded = authStore.seedWorkspace({
      email: 'ada@open-design.ai',
      displayName: 'Ada Showcase',
    });
    const browserSession = await createBrowserSession(authStore, {
      userId: seeded.user.id,
      workspaceId: seeded.workspace.id,
    });
    const handoffApp = new Hono<AuthEnv>();
    handoffApp.route('/', createDesktopHandoffRoutes({ config: cloudConfig, store: authStore, cache: authCache }));

    // Create authHandoff BEFORE signedConfig migration (just like desktop/src/main.ts!)
    let openedLoginUrl = '';
    let exchangeResponseCookie = '';
    let lastExchangePayload: { url: string; body: string } | null = null;
    authHandoff = new DesktopAuthHandoffManager({
      getStudioOrigin: () => resolveStudioOrigin(),
      openExternal: url => {
        openedLoginUrl = url;
      },
      exchangeFetch: async (url, init) => {
        assert.equal(url, 'https://studio.open-design.ai/auth/desktop/exchange');
        lastExchangePayload = { url, body: init.body };
        const res = await handoffApp.fetch(
          new Request(url, {
            method: 'POST',
            headers: init.headers,
            body: init.body,
          }),
        );
        exchangeResponseCookie = res.headers.get('set-cookie') ?? '';
        const text = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          json: async () => JSON.parse(text),
        };
      },
    });

    // Apply signed config envelope migrating studioUrl -> https://studio.open-design.ai
    const envelope = signConfigEnvelope({
      sequence: 1,
      issuedAt: nowIso,
      expiresAt: '2026-11-24T08:00:00.000Z',
      certificate: dailyCert,
      payload: migratedPayload,
      dailyPrivateKey: dailyKeys.privateKey,
    });
    const applied = signedConfig.applyEnvelope(envelope);
    assert.equal(applied.applied, true);
    assert.equal(resolveStudioOrigin(), 'https://studio.open-design.ai');

    // Execute REAL PKCE S256 handoff: Desktop startLogin -> Hono GET /auth/desktop/start ->
    // 302 redirect to Desktop 127.0.0.1 loopback -> Hono POST /auth/desktop/exchange -> Set-Cookie!
    const loginAttempt = await authHandoff.startLogin();
    assert.ok(openedLoginUrl.startsWith('https://studio.open-design.ai/auth/desktop/start?'));
    const startRes = await handoffApp.fetch(
      new Request(openedLoginUrl, {
        method: 'GET',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(browserSession.token)}`,
        },
      }),
    );
    assert.equal(startRes.status, 302, 'Authenticated browser session must 302 redirect to desktop loopback');
    const redirectTarget = startRes.headers.get('location') ?? '';
    assert.ok(redirectTarget.startsWith(loginAttempt.redirectUri));

    const callbackRes = await fetch(redirectTarget);
    assert.equal(callbackRes.status, 200);
    const authFinal = await loginAttempt.completion;
    assert.equal(authFinal.status, 'authenticated');
    assert.equal(authFinal.workspaceId, seeded.workspace.id);
    assert.equal(authFinal.user?.email, 'ada@open-design.ai');
    assert.match(exchangeResponseCookie, new RegExp(`${SESSION_COOKIE_NAME}=[^;]+`));
    assert.match(exchangeResponseCookie, /HttpOnly/i);

    // Replaying the same one-time code MUST be rejected with HTTP 401!
    assert.ok(lastExchangePayload);
    const replayRes = await handoffApp.fetch(
      new Request(lastExchangePayload.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: lastExchangePayload.body,
      }),
    );
    assert.equal(replayRes.status, 401, 'Replayed PKCE handoff code must be rejected with 401');

    // Verify in-window auth fallback allows accounts.open-design.ai OIDC, forces billing URLs
    // (both /billing path AND ?billing= query param) external, and denies privileged IPC!
    const navOidc = evaluateNavigationPolicy('https://accounts.open-design.ai/oauth/authorize', {
      studioOrigin: resolveStudioOrigin(),
      channel: 'stable',
      windowPolicy: signedConfig.getActiveConfig().windowPolicy,
      inWindowAuthFallbackActive: true,
    });
    assert.equal(navOidc.action, 'allow');

    const navBillingQuery = evaluateNavigationPolicy('https://studio.open-design.ai/settings?billing=plan', {
      studioOrigin: resolveStudioOrigin(),
      channel: 'stable',
      windowPolicy: signedConfig.getActiveConfig().windowPolicy,
      inWindowAuthFallbackActive: true,
    });
    assert.equal(navBillingQuery.action, 'deny');
    assert.equal(navBillingQuery.openExternal, true);
    assert.equal(navBillingQuery.isBillingOrAccountPortal, true);

    const mainFrameAuth = { url: 'https://studio.open-design.ai/auth/login', parent: null };
    const mainWinAuth = { webContents: { id: 10, mainFrame: mainFrameAuth } };
    assert.equal(
      authorizePrivilegedIpcSender(
        { sender: mainWinAuth.webContents, senderFrame: mainFrameAuth },
        { mainWindow: mainWinAuth, studioOrigin: resolveStudioOrigin(), channel: 'stable' },
      ).ok,
      false,
      'Privileged IPC must be denied on /auth/* pages',
    );

    const mainFrameStudio = { url: 'https://studio.open-design.ai/mcp-setup', parent: null };
    const mainWinStudio = { webContents: { id: 11, mainFrame: mainFrameStudio } };
    assert.equal(
      authorizePrivilegedIpcSender(
        { sender: mainWinStudio.webContents, senderFrame: mainFrameStudio },
        {
          mainWindow: mainWinStudio,
          studioOrigin: resolveStudioOrigin(),
          channel: 'stable',
          inWindowAuthFallbackActive: true,
        },
      ).ok,
      false,
      'Privileged IPC must be denied while in-window auth fallback is active',
    );

    // Verify retry.html splash guard allows both retryStartup and exportDiagnostics strictly from local file://
    const retryPath = '/app/dist/retry.html';
    const fakeFrame = { url: `file://${retryPath}`, parent: null };
    const fakeWin = { webContents: { id: 9, mainFrame: fakeFrame } };
    assert.equal(
      authorizeSplashSender(
        { sender: fakeWin.webContents, senderFrame: fakeFrame },
        'exportDiagnostics',
        { splashWindow: fakeWin, allowedFilePaths: [retryPath] },
      ).ok,
      true,
    );

    // Smoke-check the REAL compiled `desktop/dist/preload.cjs` bundle (when built)
    const preloadBundlePath = path.resolve(process.cwd(), 'desktop/dist/preload.cjs');
    if (existsSync(preloadBundlePath)) {
      const studioExposed = evaluateBuiltPreloadBundle(preloadBundlePath, 'https://studio.open-design.ai/mcp-setup');
      assert.ok(studioExposed.__OPENMOTION_HOST__, 'Studio page must receive __OPENMOTION_HOST__');
      assert.equal(studioExposed.__OPENMOTION_LOCAL_PAGE__, undefined, 'Studio page must NOT receive __OPENMOTION_LOCAL_PAGE__');

      const retryExposed = evaluateBuiltPreloadBundle(preloadBundlePath, 'file:///app/dist/retry.html');
      assert.ok(retryExposed.__OPENMOTION_LOCAL_PAGE__, 'Local retry page must receive __OPENMOTION_LOCAL_PAGE__');
      assert.equal(retryExposed.__OPENMOTION_HOST__, undefined, 'Local retry page must NOT receive __OPENMOTION_HOST__');

      const subframeExposed = evaluateBuiltPreloadBundle(
        preloadBundlePath,
        'https://studio.open-design.ai/mcp-setup',
        { isSubframe: true },
      );
      assert.equal(subframeExposed.__OPENMOTION_HOST__, undefined, 'Subframe must NEVER receive __OPENMOTION_HOST__');
      assert.equal(subframeExposed.__OPENMOTION_LOCAL_PAGE__, undefined);

      const authRouteExposed = evaluateBuiltPreloadBundle(
        preloadBundlePath,
        'https://studio.open-design.ai/auth/login',
      );
      assert.equal(authRouteExposed.__OPENMOTION_HOST__, undefined, '/auth/* page must NEVER receive __OPENMOTION_HOST__');

      // Built dist/scripts/diagnostics.mjs must exist so packaged desktop diagnostic export works!
      assert.equal(
        existsSync(path.resolve(process.cwd(), 'desktop/dist/scripts/diagnostics.mjs')),
        true,
        'desktop/dist/scripts/diagnostics.mjs must be copied by desktop build',
      );
      assert.equal(
        existsSync(path.resolve(process.cwd(), 'desktop/dist/scripts/zip.mjs')),
        true,
        'desktop/dist/scripts/zip.mjs must be copied by desktop build',
      );
    }

    // -----------------------------------------------------------------------
    // Step 3: Local Atoms runtime — detect, shell-enforced mcpUrl, Claude replace,
    //         atom.config (Atom 5), and Murmur schema 1
    // -----------------------------------------------------------------------
    let remoteRevokeMode: 'fail-503' | 'ok' = 'fail-503';
    const revokeCalls: Array<{
      url: string;
      headers: Record<string, string> | undefined;
      body: Record<string, unknown>;
    }> = [];
    let confirmCalls = 0;
    const secretStore = createMemorySecretStore();

    const runtime = createLocalAtomsRuntime({
      dataDir,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: binDir },
      loginShellRunner: async () => '',
      channel: 'stable',
      getExpectedMcpUrl: () => `${resolveStudioOrigin()}/mcp`,
      shellVersion: '0.2.1',
      getSignedConfig: () => signedConfig.getActiveConfig(),
      confirmCallback: async () => {
        confirmCalls += 1;
        return true;
      },
      secretStore,
      engineHttpProbe: async () => ({ reachable: false }),
      downloader: async (_url, dest) => {
        writeFileSync(dest, murmurBinaryBytes);
        return { bytesWritten: murmurBinaryBytes.length };
      },
      codeSignatureVerifier: async (_filePath, expectedTeamId) => ({ ok: true, teamId: expectedTeamId }),
      credentialHttpClient: async (url, options) => {
        if (url.endsWith('/auth/device/start')) {
          return {
            status: 200,
            body: {
              device_code: 'dev-code-secret',
              verification_uri: 'https://studio.open-design.ai/device',
              user_code: 'OD-2420',
              expires_in: 600,
              interval: 1,
            },
          };
        }
        if (url.endsWith('/auth/device/token')) {
          return {
            status: 200,
            body: {
              access_token: 'od_rt_showcase_secret_999',
              account_id: 'acct-ada',
              installation_id: 'inst-ada-001',
            },
          };
        }
        if (url.endsWith('/auth/device/revoke')) {
          revokeCalls.push({ url, headers: options.headers, body: options.body });
          if (remoteRevokeMode === 'fail-503') {
            return { status: 503, body: { error: 'service_unavailable' } };
          }
          return { status: 200, body: { revoked: true } };
        }
        return { status: 404, body: {} };
      },
    });

    // 3a. Detect finds codex, claude (with conflict against migrated studio.open-design.ai),
    // AND standalone murmur with real schema 1 JSON despite signed-out exit code 1!
    const detect1 = await runtime.atoms.detect.scan();
    assert.equal(detect1.ok, true);
    if (!detect1.ok) throw new Error('detect1 failed');
    const codex1 = detect1.data.agents.find(a => a.agentId === 'codex')!;
    const claude1 = detect1.data.agents.find(a => a.agentId === 'claude')!;
    assert.equal(codex1.installed, true);
    assert.equal(codex1.mcpConfigured, false);
    assert.equal(claude1.installed, true);
    assert.equal(claude1.mcpConfigured, true);
    assert.equal(claude1.mcpConflict, true);
    assert.equal(detect1.data.engine.installed, true);
    assert.equal(detect1.data.engine.binaryPath, standaloneMurmurPath);
    assert.equal(detect1.data.engine.signedIn, false);
    assert.equal(detect1.data.engine.servedBy, 'personal');
    assert.equal(detect1.data.engine.mode, 'personal');
    assert.equal(detect1.data.engine.version, '0.9.4');
    assert.equal(detect1.data.engine.running, true);

    // 3b. Reject renderer-supplied mcpUrl that disagrees with shell-configured studioOrigin!
    const spoofedMcp = await runtime.atoms.exec.run({
      featureId: 'mcp_connect',
      templateId: 'codex.mcp.add_remote',
      args: { serverName: 'openmotion', mcpUrl: 'https://evil-tenant.open-design.ai/mcp' },
    });
    assert.equal(spoofedMcp.ok, false);
    if (!spoofedMcp.ok) {
      assert.equal(spoofedMcp.error.code, 'ORIGIN_DENIED');
    }

    // 3c. Connect Codex omitting mcpUrl -> shell injects migrated https://studio.open-design.ai/mcp!
    const codexAdd = await runtime.atoms.exec.run({
      featureId: 'mcp_connect',
      templateId: 'codex.mcp.add_remote',
      args: { serverName: 'openmotion' },
    });
    assert.equal(codexAdd.ok, true);
    assert.match(
      readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8'),
      /https:\/\/studio\.open-design\.ai\/mcp/,
    );

    // 3d. Claude Code abort returns CONFLICT; replace runs `mcp remove` BEFORE `mcp add` and succeeds!
    const claudeConflict = await runtime.atoms.exec.run({
      featureId: 'mcp_connect',
      templateId: 'claude.mcp.add_remote',
      args: { serverName: 'openmotion' },
      conflictPolicy: 'abort',
    });
    assert.equal(claudeConflict.ok, false);
    if (!claudeConflict.ok) assert.equal(claudeConflict.error.code, 'CONFLICT');

    const claudeReplace = await runtime.atoms.exec.run({
      featureId: 'mcp_connect',
      templateId: 'claude.mcp.add_remote',
      args: { serverName: 'openmotion' },
      conflictPolicy: 'replace',
    });
    assert.equal(claudeReplace.ok, true);
    const claudeCfgAfter = JSON.parse(readFileSync(path.join(homeDir, '.claude.json'), 'utf8'));
    assert.equal(claudeCfgAfter.mcpServers.openmotion.url, 'https://studio.open-design.ai/mcp');
    assert.equal(claudeCfgAfter.mcpServers.sibling.url, 'https://other.example/mcp');

    // 3e. Atom 5 (`atom.config`): read, shell-enforced URL rejection, legacy stdio conflict,
    //     backup + authorized restoreBackup!
    const cfgRead = await runtime.atoms.config.read({ ruleId: 'codex_mcp', serverName: 'openmotion' });
    assert.equal(cfgRead.ok, true);
    if (cfgRead.ok) assert.equal(cfgRead.data.entry?.url, 'https://studio.open-design.ai/mcp');

    const cfgSpoof = await runtime.atoms.config.write({
      featureId: 'mcp_connect',
      ruleId: 'codex_mcp',
      fieldType: 'remote_mcp_entry',
      value: { serverName: 'openmotion', url: 'https://evil-tenant.open-design.ai/mcp' },
    });
    assert.equal(cfgSpoof.ok, false);
    if (!cfgSpoof.ok) assert.equal(cfgSpoof.error.code, 'ORIGIN_DENIED');

    const codexTomlPath = path.join(homeDir, '.codex', 'config.toml');
    const savedCodexToml = readFileSync(codexTomlPath, 'utf8');
    writeFileSync(
      codexTomlPath,
      '[mcp_servers.openmotion]\ncommand = "npx"\nargs = ["-y", "openmotion-mcp"]\n',
      'utf8',
    );
    const stdioConflict = await runtime.atoms.config.write({
      featureId: 'mcp_connect',
      ruleId: 'codex_mcp',
      fieldType: 'remote_mcp_entry',
      value: { serverName: 'openmotion', url: 'https://studio.open-design.ai/mcp' },
    });
    assert.equal(stdioConflict.ok, false);
    if (!stdioConflict.ok) assert.equal(stdioConflict.error.code, 'CONFLICT');

    const cfgReplace = await runtime.atoms.config.write({
      featureId: 'mcp_connect',
      ruleId: 'codex_mcp',
      fieldType: 'remote_mcp_entry',
      value: { serverName: 'openmotion', url: 'https://studio.open-design.ai/mcp' },
      conflictPolicy: 'replace',
    });
    assert.equal(cfgReplace.ok, true);
    assert.ok(cfgReplace.ok && cfgReplace.data.backupPath);

    // Restore backup requires valid featureId, then restores pre-replace file cleanly
    const unauthRestore = await runtime.atoms.config.restoreBackup({ backupPath: cfgReplace.data.backupPath! });
    assert.equal(unauthRestore.ok, false);
    const okRestore = await runtime.atoms.config.restoreBackup({
      featureId: 'mcp_connect',
      backupPath: cfgReplace.data.backupPath!,
    });
    assert.equal(okRestore.ok, true);
    assert.match(readFileSync(codexTomlPath, 'utf8'), /command = "npx"/);
    // Restore clean converged Codex TOML for subsequent detect & Connect Script checks
    writeFileSync(codexTomlPath, savedCodexToml, 'utf8');

    // Re-detect confirms BOTH agents are now configured with ZERO conflict
    const detect2 = await runtime.atoms.detect.scan();
    assert.equal(detect2.ok, true);
    if (detect2.ok) {
      assert.equal(detect2.data.agents.find(a => a.agentId === 'codex')?.mcpConflict, false);
      assert.equal(detect2.data.agents.find(a => a.agentId === 'claude')?.mcpConflict, false);
    }

    // 3f. Declarative multi-agent ecosystem (Cursor + OpenCode): detected via home config dir
    //     WITHOUT PATH CLI binaries, configured via `atom.config.write` (standard http vs opencode remote),
    //     and malformed params rejected by unified Zod schema layer!
    mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });
    mkdirSync(path.join(homeDir, '.config', 'opencode'), { recursive: true });

    const detectDeclarative = await runtime.invoke(HOST_CAPABILITIES.ATOM_DETECT, 'scan');
    assert.equal(detectDeclarative.ok, true);
    if (detectDeclarative.ok) {
      const agents = (detectDeclarative.data as { agents: Array<{ agentId: string; installed: boolean; connectMode?: string; configRuleId?: string }> }).agents;
      const cursor = agents.find(a => a.agentId === 'cursor');
      const opencode = agents.find(a => a.agentId === 'opencode');
      assert.equal(cursor?.installed, true);
      assert.equal(cursor?.connectMode, 'config');
      assert.equal(cursor?.configRuleId, 'cursor_mcp');
      assert.equal(opencode?.installed, true);
      assert.equal(opencode?.connectMode, 'config');
      assert.equal(opencode?.configRuleId, 'opencode_mcp');
    }

    // Unified Zod schema rejects unknown fields on runtime.invoke BEFORE reaching atom logic
    const badSchemaWrite = await runtime.invoke(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
      featureId: 'mcp_connect',
      ruleId: 'cursor_mcp',
      fieldType: 'remote_mcp_entry',
      value: { serverName: 'openmotion', url: 'https://studio.open-design.ai/mcp' },
      unexpectedExtraField: 'evil',
    });
    assert.equal(badSchemaWrite.ok, false);
    if (!badSchemaWrite.ok) assert.equal(badSchemaWrite.error.code, 'INVALID_PARAMS');

    const cursorWrite = await runtime.invoke(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
      featureId: 'mcp_connect',
      ruleId: 'cursor_mcp',
      fieldType: 'remote_mcp_entry',
      value: { serverName: 'openmotion', url: 'https://studio.open-design.ai/mcp' },
    });
    assert.equal(cursorWrite.ok, true);
    const cursorJson = JSON.parse(readFileSync(path.join(homeDir, '.cursor', 'mcp.json'), 'utf8'));
    assert.deepEqual(cursorJson.mcpServers.openmotion, {
      type: 'http',
      url: 'https://studio.open-design.ai/mcp',
    });

    const opencodeWrite = await runtime.invoke(HOST_CAPABILITIES.ATOM_CONFIG, 'write', {
      featureId: 'mcp_connect',
      ruleId: 'opencode_mcp',
      fieldType: 'remote_mcp_entry',
      value: { serverName: 'openmotion', url: 'https://studio.open-design.ai/mcp' },
    });
    assert.equal(opencodeWrite.ok, true);
    const opencodeJson = JSON.parse(readFileSync(path.join(homeDir, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.deepEqual(opencodeJson.mcp.openmotion, {
      type: 'remote',
      url: 'https://studio.open-design.ai/mcp',
    });

    // -----------------------------------------------------------------------
    // Step 4: Murmur reuse + Apple codesign requirement + unified install path
    // -----------------------------------------------------------------------
    assert.equal(buildMacOsDeveloperIdRequirement('INVALID_TEAM'), null);
    assert.match(
      buildMacOsDeveloperIdRequirement('AB12CD34EF') ?? '',
      /=anchor apple generic and certificate 1\[field\.1\.2\.840\.113635\.100\.6\.2\.6\].*subject\.OU\] = "AB12CD34EF"/,
    );
    const badTeamCheck = await defaultCodeSignatureVerifier(
      standaloneMurmurPath,
      'POWERFORMER_MURMUR_TEAM_ID_PENDING',
      'darwin',
    );
    assert.equal(badTeamCheck.ok, false);

    // Existing standalone Murmur at ~/.murmurant/bin/murmur is reused without overwriting!
    const originalStandaloneContent = readFileSync(standaloneMurmurPath, 'utf8');
    const reuseRes = await runtime.atoms.installComponent.install({
      featureId: 'murmur_gateway',
      componentId: MURMUR_COMPONENT_ID,
    });
    assert.equal(reuseRes.ok, true);
    if (reuseRes.ok) {
      assert.equal(reuseRes.data.alreadyInstalled, true);
      assert.equal(reuseRes.data.reusedExisting, true);
      assert.equal(reuseRes.data.installPath, standaloneMurmurPath);
    }
    assert.equal(readFileSync(standaloneMurmurPath, 'utf8'), originalStandaloneContent);

    // -----------------------------------------------------------------------
    // Step 5: Credential device-auth -> stdin-only inject into standalone Murmur -> pending_revoke & account isolation
    // -----------------------------------------------------------------------
    const credStart = await runtime.atoms.credential.start({
      featureId: 'murmur_gateway',
      credentialId: 'opendesign_runtime',
    });
    assert.equal(credStart.ok, true);
    if (!credStart.ok) throw new Error('credStart failed');

    const credPoll = await runtime.atoms.credential.poll({
      featureId: 'murmur_gateway',
      credentialId: 'opendesign_runtime',
      sessionId: credStart.data.sessionId,
    });
    assert.equal(credPoll.ok, true);
    if (!credPoll.ok || credPoll.data.status !== 'authorized') throw new Error('credPoll failed');

    // Inject runtime key into standalone Murmur via stdin-only `magpie provider add opendesign url=... list=off --api-key-stdin`
    const injectRes = await runtime.atoms.credential.inject({
      featureId: 'murmur_gateway',
      credentialId: 'opendesign_runtime',
      templateId: MURMUR_COMMAND_TEMPLATES.PROVIDER_UPSERT.templateId,
      args: { providerId: 'opendesign', providerUrl: 'https://studio.open-design.ai/v1' },
    });
    assert.equal(injectRes.ok, true);
    if (injectRes.ok) {
      // Echoed secret MUST be scrubbed!
      assert.equal(injectRes.data.stdout.includes('od_rt_showcase_secret_999'), false);
      assert.match(injectRes.data.stdout, /\[REDACTED\]/);
    }

    // Verify logged commands: Claude did remove-before-add, Murmur got MURMUR_MENUBAR=off and stdin secret!
    const logged = readFileSync(commandLogPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { cmd: string; args: string[]; menubarEnv?: string; stdinHasSecret?: boolean });
    const claudeCalls = logged.filter(e => e.cmd === 'claude' && e.args[0] === 'mcp');
    assert.deepEqual(
      claudeCalls.map(e => e.args[1]),
      ['remove', 'add'],
    );
    const murmurAddCall = logged.find(e => e.cmd === 'murmur' && e.args[0] === 'magpie' && e.args[2] === 'add');
    assert.ok(murmurAddCall);
    assert.equal(murmurAddCall.menubarEnv, 'off');
    assert.equal(murmurAddCall.stdinHasSecret, true);
    assert.equal(murmurAddCall.args.join(' ').includes('od_rt_showcase_secret_999'), false);

    // Cross-account revoke rejection: Account B cannot revoke Account A's credential!
    const crossAccountRevoke = await runtime.atoms.credential.revoke({
      featureId: 'murmur_gateway',
      credentialId: 'opendesign_runtime',
      accountId: 'acct-bob',
    });
    assert.equal(crossAccountRevoke.ok, false);
    if (!crossAccountRevoke.ok) assert.equal(crossAccountRevoke.error.code, 'UNAUTHORIZED');

    // Account A revoke fails remotely (HTTP 503) -> local secret purged, metadata marked pending_revoke!
    const failedRevoke = await runtime.atoms.credential.revoke({
      featureId: 'murmur_gateway',
      credentialId: 'opendesign_runtime',
      accountId: 'acct-ada',
    });
    assert.equal(failedRevoke.ok, true);
    if (failedRevoke.ok) {
      assert.equal(failedRevoke.data.revoked, false);
      assert.equal(failedRevoke.data.pendingRevoke, true);
    }
    assert.equal(await secretStore.get('openmotion:opendesign_runtime:inst-ada-001'), null);
    assert.equal(runtime.atoms.credential.listPendingRevokes('acct-ada').length, 1);

    // Retry under Account B MUST skip Account A's pending revoke!
    remoteRevokeMode = 'ok';
    const bobRetry = await runtime.atoms.credential.retryPendingRevokes({
      featureId: 'murmur_gateway',
      accountId: 'acct-bob',
    });
    assert.equal(bobRetry.ok, true);
    if (bobRetry.ok) {
      assert.equal(bobRetry.data.attempted, 0);
      assert.equal(bobRetry.data.skippedDifferentAccount, 1);
      assert.equal(bobRetry.data.remaining, 1);
    }

    // Retry under Account A succeeds, sends Authorization Bearer token, and clears pending_revoke!
    const adaRetry = await runtime.atoms.credential.retryPendingRevokes({
      featureId: 'murmur_gateway',
      accountId: 'acct-ada',
    });
    assert.equal(adaRetry.ok, true);
    if (adaRetry.ok) {
      assert.equal(adaRetry.data.attempted, 1);
      assert.equal(adaRetry.data.succeeded, 1);
      assert.equal(adaRetry.data.remaining, 0);
    }
    assert.equal(revokeCalls.length, 2, 'Expected initial failed revoke + 1 authenticated retry');
    assert.equal(
      revokeCalls[1]?.headers?.authorization ?? revokeCalls[1]?.headers?.Authorization,
      'Bearer od_rt_showcase_secret_999',
      'Retry must include quarantined Authorization Bearer header',
    );
    assert.equal(
      await secretStore.get('openmotion:pending-revoke:opendesign_runtime:inst-ada-001'),
      null,
      'Quarantined revoke secret must be purged after successful retry',
    );
    const finalCredStatus = await runtime.atoms.credential.status({ credentialId: 'opendesign_runtime' });
    assert.equal(finalCredStatus.ok, true);
    if (finalCredStatus.ok) {
      assert.equal(finalCredStatus.data.status, 'revoked');
      assert.equal(finalCredStatus.data.pendingRevoke, false);
    }

    // -----------------------------------------------------------------------
    // Step 6: minShellVersion rejects outdated shell BEFORE confirmation prompt
    // -----------------------------------------------------------------------
    const confirmCallsBeforeTooOld = confirmCalls;
    const tooOld = await runtime.atoms.exec.run({
      featureId: 'future_feature',
      templateId: 'codex.mcp.add_remote',
      args: { serverName: 'openmotion' },
    });
    assert.equal(tooOld.ok, false);
    assert.equal(
      confirmCalls,
      confirmCallsBeforeTooOld,
      'minShellVersion rejection must happen BEFORE showing any confirmation dialog',
    );
    if (!tooOld.ok) {
      assert.equal(tooOld.error.code, 'UNSUPPORTED');
      assert.equal(tooOld.error.details?.reason, 'SHELL_VERSION_TOO_OLD');
      assert.equal(tooOld.error.details?.requiredShellVersion, '0.9.0');
      assert.equal(tooOld.error.details?.currentShellVersion, '0.2.1');
    }

    // -----------------------------------------------------------------------
    // Step 7: Web Connect Script real loopback HTTP + SSE + hash pairing URL
    //         AND one-shot `runConnectCli` CLI orchestration
    // -----------------------------------------------------------------------
    const connectDataDir = path.join(rootTmp, 'connect-data');
    const connectBridge = await resolveConnectBridge({
      dataDir: connectDataDir,
      homeDir,
      channel: 'stable',
      studioUrl: 'https://studio.open-design.ai',
      confirm: async () => true,
      engineHttpProbe: async () => ({ reachable: false }),
      pathResolver: runtime.pathResolver,
    });
    const server = await startConnectScriptServer({
      bridge: connectBridge,
      port: 0,
      channel: 'stable',
    });
    try {
      const pairingUrl = buildStudioPairingUrl({
        studioUrl: 'https://studio.open-design.ai/mcp/',
        port: server.port,
        token: server.token,
      });
      const parsedPair = new URL(pairingUrl);
      assert.equal(parsedPair.pathname, '/mcp-setup', 'Pairing URL must normalize /mcp/ to /mcp-setup');
      const hashParams = new URLSearchParams(parsedPair.hash.slice(1));
      assert.equal(hashParams.get('connect_port'), String(server.port));
      assert.equal(hashParams.get('connect_token'), server.token);
      assert.equal(parsedPair.search, '', 'Pairing token must NEVER appear in query string');

      // Verify Chromium Private Network Access (PNA) preflight from HTTPS Studio -> 127.0.0.1
      const pnaPreflight = await fetch(`${server.baseUrl}/v1/invoke`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://studio.open-design.ai',
          'Access-Control-Request-Private-Network': 'true',
        },
      });
      assert.equal(pnaPreflight.status, 204);
      assert.equal(pnaPreflight.headers.get('access-control-allow-private-network'), 'true');

      const invokeRes = await fetch(`${server.baseUrl}/v1/invoke`, {
        method: 'POST',
        headers: {
          Origin: 'https://studio.open-design.ai',
          'Content-Type': 'application/json',
          'x-openmotion-connect-token': server.token,
        },
        body: JSON.stringify({
          capability: HOST_CAPABILITIES.ATOM_DETECT,
          method: 'scan',
        }),
      });
      assert.equal(invokeRes.status, 200);
      const invokeJson = (await invokeRes.json()) as {
        ok: boolean;
        data?: { agents: Array<{ agentId: string; mcpConfigured: boolean }> };
      };
      assert.equal(invokeJson.ok, true);
      assert.equal(invokeJson.data?.agents.find(a => a.agentId === 'codex')?.mcpConfigured, true);
      assert.equal(invokeJson.data?.agents.find(a => a.agentId === 'claude')?.mcpConfigured, true);

      // Verify real `/v1/events` SSE streaming with Origin + Token header!
      const sseController = new AbortController();
      const sseRes = await fetch(`${server.baseUrl}/v1/events`, {
        method: 'GET',
        headers: {
          Origin: 'https://studio.open-design.ai',
          Accept: 'text/event-stream',
          'x-openmotion-connect-token': server.token,
        },
        signal: sseController.signal,
      });
      assert.equal(sseRes.status, 200);
      assert.match(sseRes.headers.get('content-type') ?? '', /text\/event-stream/);
      const reader = sseRes.body!.getReader();
      const firstChunk = await reader.read();
      sseController.abort();
      reader.releaseLock();
      const sseText = new TextDecoder().decode(firstChunk.value);
      assert.match(sseText, /connected|:\s*ok/);
    } finally {
      await server.close();
    }

    // One-shot `runConnectCli` end-to-end against a clean home directory with our real Codex shim!
    const cliHome = path.join(rootTmp, 'cli-home');
    mkdirSync(cliHome, { recursive: true });
    const cliStdout = new PassThrough();
    const cliStderr = new PassThrough();
    let cliOutText = '';
    cliStdout.on('data', chunk => {
      cliOutText += chunk.toString('utf8');
    });
    const prevTestHome = process.env.OM_TEST_HOME;
    process.env.OM_TEST_HOME = cliHome;
    let cliExitCode = 1;
    try {
      cliExitCode = await runConnectCli(
        ['--connect', 'codex', '--studio-url', 'https://studio.open-design.ai', '--yes'],
        {
          output: cliStdout,
          errorOutput: cliStderr,
          createBridge: opts =>
            resolveConnectBridge({
              ...opts,
              dataDir: path.join(rootTmp, 'cli-data'),
              homeDir: cliHome,
              engineHttpProbe: async () => ({ reachable: false }),
              pathResolver: runtime.pathResolver,
            }),
        },
      );
    } finally {
      if (prevTestHome === undefined) delete process.env.OM_TEST_HOME;
      else process.env.OM_TEST_HOME = prevTestHome;
    }
    assert.equal(cliExitCode, 0, `runConnectCli failed; output: ${cliOutText}`);
    assert.match(cliOutText, /Codex/i);
    assert.match(
      readFileSync(path.join(cliHome, '.codex', 'config.toml'), 'utf8'),
      /https:\/\/studio\.open-design\.ai\/mcp/,
      'runConnectCli must write Codex config into isolated cliHome',
    );

    // -----------------------------------------------------------------------
    // Step 8: Fresh Murmur install lands in unified `~/.murmurant/bin/murmur` (M5)
    //         and uninstall removes ONLY the binary file, preserving sibling files!
    // -----------------------------------------------------------------------
    const freshHome = path.join(rootTmp, 'fresh-home');
    const freshData = path.join(rootTmp, 'fresh-data');
    mkdirSync(path.join(freshHome, '.murmurant', 'bin'), { recursive: true });
    const siblingFile = path.join(freshHome, '.murmurant', 'bin', 'keep-me.txt');
    writeFileSync(siblingFile, 'user-sibling', 'utf8');

    let freshDownloads = 0;
    const freshRuntime = createLocalAtomsRuntime({
      dataDir: freshData,
      homeDir: freshHome,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      shellVersion: '0.2.1',
      getSignedConfig: () => migratedPayload,
      confirmCallback: async () => true,
      downloader: async (_url, dest) => {
        freshDownloads += 1;
        writeFileSync(dest, murmurBinaryBytes);
        return { bytesWritten: murmurBinaryBytes.length };
      },
      codeSignatureVerifier: async (_filePath, expectedTeamId) => ({ ok: true, teamId: expectedTeamId }),
    });

    const freshInstall = await freshRuntime.atoms.installComponent.install({
      featureId: 'murmur_gateway',
      componentId: MURMUR_COMPONENT_ID,
    });
    assert.equal(freshInstall.ok, true);
    assert.equal(freshDownloads, 1);
    const expectedUnifiedPath = getUnifiedMurmurBinaryPath(freshHome, 'darwin');
    if (freshInstall.ok) {
      assert.equal(freshInstall.data.installPath, expectedUnifiedPath);
      assert.equal(existsSync(expectedUnifiedPath), true);
    }

    // Simulate Murmur's own updater upgrading `~/.murmurant/bin/murmur` in-place to v0.9.9:
    // calling `installComponent.install` again must REUSE v0.9.9 without downloading or downgrading!
    const selfUpdatedMurmur = `#!${nodeBin}\nconsole.log('murmur 0.9.9');\n`;
    writeExecutableScript(expectedUnifiedPath, selfUpdatedMurmur);
    const afterSelfUpdate = await freshRuntime.atoms.installComponent.install({
      featureId: 'murmur_gateway',
      componentId: MURMUR_COMPONENT_ID,
    });
    assert.equal(afterSelfUpdate.ok, true);
    assert.equal(freshDownloads, 1, 'Must never re-download or overwrite self-updated Murmur binary');
    if (afterSelfUpdate.ok) {
      assert.equal(afterSelfUpdate.data.version, '0.9.9');
      assert.equal(afterSelfUpdate.data.reusedExisting, true);
    }
    assert.equal(readFileSync(expectedUnifiedPath, 'utf8'), selfUpdatedMurmur);

    const freshUninstall = await freshRuntime.atoms.installComponent.uninstall({
      featureId: 'murmur_gateway',
      componentId: MURMUR_COMPONENT_ID,
    });
    assert.equal(freshUninstall.ok, true);
    assert.equal(existsSync(expectedUnifiedPath), false);
    assert.equal(existsSync(siblingFile), true, 'Uninstall must NEVER delete sibling files in ~/.murmurant/bin');
  } finally {
    authHandoff?.dispose();
    rmSync(rootTmp, { recursive: true, force: true });
  }
});
