import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STUDIO_URLS } from '../../shared/desktop-builtin-rules.ts';
import { HOST_CAPABILITIES, hostOk } from '../../shared/desktop-contract.ts';
import {
  CapabilityRegistry,
  createAccountCapabilityModule,
  createDiagnosticsCapabilityModule,
  createPreferencesCapabilityModule,
  createUpdaterCapabilityModule,
  createWebContentsEventSink,
  createWindowCapabilityModule,
} from '../src/capability-registry.ts';
import {
  authorizePrivilegedIpcSender,
  authorizeSplashSender,
  HOST_IPC_CHANNELS,
  resolveAllowedStudioOrigins,
} from '../src/ipc-guard.ts';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeWindowMock(id, url) {
  const mainFrame = { url, parent: null };
  mainFrame.top = mainFrame;
  const webContents = {
    id,
    mainFrame,
    isDestroyed: () => false,
  };
  return {
    isDestroyed: () => false,
    webContents,
    mainFrame,
  };
}

test('CapabilityRegistry returns UNSUPPORTED for unknown capabilities, unknown methods, prototype keys, and unavailable modules without throwing', async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    name: 'sample',
    version: '1.0.0',
    status: 'available',
    methods: {
      ping: {
        handler: async () => hostOk({ pong: true }),
      },
    },
  });
  registry.register({
    name: 'offlineCap',
    version: '1.0.0',
    status: 'unavailable',
    reason: 'Feature disabled on this platform',
    methods: {
      run: {
        handler: async () => hostOk({ ran: true }),
      },
    },
  });

  const unknownCap = await registry.invoke('doesNotExist', 'ping');
  assert.equal(unknownCap.ok, false);
  assert.equal(unknownCap.error.code, 'UNSUPPORTED');

  const unknownMethod = await registry.invoke('sample', 'doesNotExist');
  assert.equal(unknownMethod.ok, false);
  assert.equal(unknownMethod.error.code, 'UNSUPPORTED');

  for (const protoKey of ['toString', 'constructor', '__proto__', 'valueOf']) {
    const protoRes = await registry.invoke('sample', protoKey);
    assert.equal(protoRes.ok, false);
    assert.equal(protoRes.error.code, 'UNSUPPORTED');
  }

  const unavailableRes = await registry.invoke('offlineCap', 'run');
  assert.equal(unavailableRes.ok, false);
  assert.equal(unavailableRes.error.code, 'UNSUPPORTED');
  assert.equal(unavailableRes.error.message, 'Feature disabled on this platform');

  const pingRes = await registry.invoke('sample', 'ping');
  assert.deepEqual(pingRes, { ok: true, data: { pong: true } });

  assert.equal(registry.setStatus('sample', 'unavailable', 'Paused for maintenance'), true);
  const pausedRes = await registry.invoke('sample', 'ping');
  assert.equal(pausedRes.ok, false);
  assert.equal(pausedRes.error.code, 'UNSUPPORTED');
  assert.equal(pausedRes.error.message, 'Paused for maintenance');
});

test('CapabilityRegistry validates envelope types, method params, and sanitizes internal handler errors', async () => {
  const internalErrors = [];
  const registry = new CapabilityRegistry({
    onInternalError: info => internalErrors.push(info),
  });

  registry.register({
    name: 'validatorTest',
    version: '1.0.0',
    status: 'available',
    methods: {
      echoCount: {
        validate: params => {
          if (typeof params.count !== 'number' || !Number.isInteger(params.count) || params.count < 1) {
            return {
              ok: false,
              message: 'Parameter "count" must be a positive integer',
              details: { field: 'count' },
            };
          }
          return { ok: true, value: { count: params.count } };
        },
        handler: async ({ count }) => hostOk({ count }),
      },
      boom: {
        handler: async () => {
          throw new Error('Fatal secret token=om_mcp_supersecret12345 at /opt/dev/private.ts:42');
        },
      },
      malformed: {
        handler: async () => ({ unexpected: true }),
      },
    },
  });

  assert.equal((await registry.invoke('', 'echoCount')).error.code, 'INVALID_PARAMS');
  assert.equal((await registry.invoke('validatorTest', '   ')).error.code, 'INVALID_PARAMS');
  assert.equal((await registry.invoke(123, 'echoCount')).error.code, 'INVALID_PARAMS');
  assert.equal((await registry.invoke('validatorTest', null)).error.code, 'INVALID_PARAMS');

  for (const badParams of [null, 'str', 42, ['array'], new Date()]) {
    const res = await registry.invoke('validatorTest', 'echoCount', badParams);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_PARAMS');
  }

  const invalidCount = await registry.invoke('validatorTest', 'echoCount', { count: 0 });
  assert.equal(invalidCount.ok, false);
  assert.equal(invalidCount.error.code, 'INVALID_PARAMS');
  assert.deepEqual(invalidCount.error.details, { field: 'count' });

  const validCount = await registry.invoke('validatorTest', 'echoCount', { count: 3 });
  assert.deepEqual(validCount, { ok: true, data: { count: 3 } });

  const boomRes = await registry.invoke('validatorTest', 'boom');
  assert.equal(boomRes.ok, false);
  assert.equal(boomRes.error.code, 'INTERNAL_ERROR');
  assert.equal(boomRes.error.message.includes('om_mcp_supersecret12345'), false);
  assert.equal(boomRes.error.message.includes('/Users/dev'), false);
  assert.equal(internalErrors.length, 1);
  assert.equal(internalErrors[0].capability, 'validatorTest');
  assert.equal(internalErrors[0].method, 'boom');

  const malformedRes = await registry.invoke('validatorTest', 'malformed');
  assert.equal(malformedRes.ok, false);
  assert.equal(malformedRes.error.code, 'INTERNAL_ERROR');
});

test('All four shell capability modules (window, updater, diagnostics, account) register cleanly and dispatch migrated methods and events', async () => {
  const calls = [];
  const sentEvents = [];

  let webContentsDestroyed = false;
  const fakeWebContents = {
    isDestroyed: () => webContentsDestroyed,
    send: (channel, payload) => {
      sentEvents.push({ channel, payload });
    },
  };

  const registry = new CapabilityRegistry({
    sinks: [
      () => {
        throw new Error('broken sink should not affect other sinks');
      },
      createWebContentsEventSink(() => fakeWebContents),
    ],
  });

  const chromeState = {
    platform: 'darwin',
    titleBarStyle: 'hiddenInset',
    insetLeft: 78,
    insetRight: 0,
    titleBarHeight: 46,
    customWindowControls: false,
    fullscreen: false,
    maximized: false,
  };
  const updateState = {
    status: 'available',
    currentVersion: '0.2.1',
    availableVersion: '0.3.0',
  };

  registry
    .register(
      createWindowCapabilityModule({
        getChromeState: () => chromeState,
        setTheme: theme => {
          calls.push(['window.setTheme', theme]);
        },
        minimize: () => {
          calls.push(['window.minimize']);
        },
        toggleMaximize: () => {
          calls.push(['window.toggleMaximize']);
        },
        close: () => {
          calls.push(['window.close']);
        },
        openExternal: url => {
          calls.push(['window.openExternal', url]);
          return { ok: true };
        },
        notifyRendererReady: () => {
          calls.push(['window.notifyRendererReady']);
        },
        retryStartup: () => {
          calls.push(['window.retryStartup']);
        },
        continueToStudio: () => {
          calls.push(['window.continueToStudio']);
        },
      }),
    )
    .register(
      createUpdaterCapabilityModule({
        getUpdateState: () => updateState,
        checkForUpdates: async () => ({ ...updateState, status: 'checking' }),
        downloadUpdate: async () => ({ ...updateState, status: 'downloading', progress: 50 }),
        installUpdateNow: async () => ({ ok: true }),
      }),
    )
    .register(
      createDiagnosticsCapabilityModule({
        getAppInfo: () => ({
          hostKind: 'desktop',
          shellVersion: '0.2.1',
          contractVersion: '1.0.0',
          platform: 'darwin',
          arch: 'arm64',
          releaseChannel: 'stable',
          isPackaged: true,
        }),
        exportLogs: async () => ({ ok: true, path: '/tmp/diag.zip', entryCount: 4 }),
        openLogsFolder: async () => ({ ok: true, path: '/tmp/logs' }),
      }),
    )
    .register(
      createAccountCapabilityModule({
        startSignIn: async params => ({ state: 'authorizing', returnPath: params?.returnPath }),
        cancelSignIn: async () => ({ state: 'signed-out' }),
        refreshAccount: async () => ({ state: 'signed-in', email: 'creator@open-design.ai' }),
        signOut: async () => ({ state: 'signed-out' }),
      }),
    );

  const descriptors = registry.listCapabilities();
  assert.deepEqual(
    descriptors.map(d => d.name),
    [
      HOST_CAPABILITIES.WINDOW,
      HOST_CAPABILITIES.UPDATER,
      HOST_CAPABILITIES.DIAGNOSTICS,
      HOST_CAPABILITIES.ACCOUNT,
    ],
  );
  for (const descriptor of descriptors) {
    assert.equal(descriptor.version, '1.0.0');
    assert.equal(descriptor.status, 'available');
    assert.ok(Array.isArray(descriptor.methods) && descriptor.methods.length > 0);
    assert.ok(Array.isArray(descriptor.events));
  }
  const byName = new Map(descriptors.map(d => [d.name, d]));
  assert.deepEqual(byName.get(HOST_CAPABILITIES.WINDOW)?.events, [
    'chromeState',
    'menuAction',
    'themeChanged',
    'focus',
    'visibility',
    'resizing',
    'deepLink',
  ]);
  assert.deepEqual(byName.get(HOST_CAPABILITIES.UPDATER)?.events, ['state']);
  assert.deepEqual(byName.get(HOST_CAPABILITIES.DIAGNOSTICS)?.events, []);
  assert.deepEqual(byName.get(HOST_CAPABILITIES.ACCOUNT)?.events, ['state']);

  // Window capability
  assert.deepEqual(await registry.invoke('window', 'getChromeState'), { ok: true, data: chromeState });
  assert.deepEqual(await registry.invoke('window', 'setTheme', { theme: 'light' }), {
    ok: true,
    data: { theme: 'light' },
  });
  assert.equal((await registry.invoke('window', 'setTheme', { theme: 'sepia' })).error.code, 'INVALID_PARAMS');
  assert.equal((await registry.invoke('window', 'minimize')).ok, true);
  assert.equal((await registry.invoke('window', 'toggleMaximize')).ok, true);
  assert.equal((await registry.invoke('window', 'close')).ok, true);
  assert.deepEqual(await registry.invoke('window', 'openExternal', { url: 'https://open-design.ai/docs' }), {
    ok: true,
    data: { ok: true },
  });
  assert.equal(
    (await registry.invoke('window', 'openExternal', { url: 'javascript:alert(1)' })).error.code,
    'INVALID_PARAMS',
  );
  assert.equal(
    (await registry.invoke('window', 'openExternal', { url: 'file:///etc/passwd' })).error.code,
    'INVALID_PARAMS',
  );
  assert.equal((await registry.invoke('window', 'rendererReady')).ok, true);
  assert.equal((await registry.invoke('window', 'retryStartup')).ok, true);
  assert.equal((await registry.invoke('window', 'continueToStudio')).ok, true);

  // Updater capability
  assert.deepEqual(await registry.invoke('updater', 'getState'), { ok: true, data: updateState });
  assert.equal((await registry.invoke('updater', 'checkForUpdates')).data.status, 'checking');
  assert.equal((await registry.invoke('updater', 'downloadUpdate')).data.progress, 50);
  assert.deepEqual(await registry.invoke('updater', 'installNow'), { ok: true, data: { ok: true } });

  // Diagnostics capability
  assert.equal((await registry.invoke('diagnostics', 'getAppInfo')).data.hostKind, 'desktop');
  assert.deepEqual(await registry.invoke('diagnostics', 'exportBundle'), {
    ok: true,
    data: { ok: true, path: '/tmp/diag.zip', entryCount: 4 },
  });
  assert.deepEqual(await registry.invoke('diagnostics', 'openLogsFolder'), {
    ok: true,
    data: { ok: true, path: '/tmp/logs' },
  });

  // Account capability
  assert.deepEqual(await registry.invoke('account', 'startBrowserLogin', { returnPath: '/projects/1' }), {
    ok: true,
    data: { state: 'authorizing', returnPath: '/projects/1' },
  });
  assert.equal(
    (await registry.invoke('account', 'startBrowserLogin', { returnPath: '//evil.com' })).error.code,
    'INVALID_PARAMS',
  );
  assert.deepEqual(await registry.invoke('account', 'cancelLogin'), {
    ok: true,
    data: { state: 'signed-out' },
  });
  assert.deepEqual(await registry.invoke('account', 'refresh'), {
    ok: true,
    data: { state: 'signed-in', email: 'creator@open-design.ai' },
  });
  assert.deepEqual(await registry.invoke('account', 'signOut'), {
    ok: true,
    data: { state: 'signed-out' },
  });

  assert.deepEqual(calls, [
    ['window.setTheme', 'light'],
    ['window.minimize'],
    ['window.toggleMaximize'],
    ['window.close'],
    ['window.openExternal', 'https://open-design.ai/docs'],
    ['window.notifyRendererReady'],
    ['window.retryStartup'],
    ['window.continueToStudio'],
  ]);

  // Event emission over openmotion:host:event
  registry.emit('window', 'chromeState', chromeState);
  registry.emit('window', 'menuAction', 'open-settings');
  registry.emit('updater', 'state', updateState);
  assert.equal(sentEvents.length, 3);
  assert.deepEqual(sentEvents[0], {
    channel: HOST_IPC_CHANNELS.EVENT,
    payload: { capability: 'window', event: 'chromeState', payload: chromeState },
  });
  assert.deepEqual(sentEvents[1], {
    channel: HOST_IPC_CHANNELS.EVENT,
    payload: { capability: 'window', event: 'menuAction', payload: 'open-settings' },
  });

  // Destroyed webContents stops receiving events safely
  webContentsDestroyed = true;
  registry.emit('updater', 'state', updateState);
  assert.equal(sentEvents.length, 3);
});

test('authorizePrivilegedIpcSender allows main window + main frame + allowed Studio origin and enforces channel boundaries', () => {
  const stableWin = makeWindowMock(10, 'https://motion.open-design.ai/projects/abc');
  const stableOk = authorizePrivilegedIpcSender(
    { sender: stableWin.webContents, senderFrame: stableWin.mainFrame },
    { mainWindow: stableWin, channel: 'stable' },
  );
  assert.equal(stableOk.ok, true);
  assert.equal(stableOk.origin, 'https://motion.open-design.ai');
  assert.equal(stableOk.webContentsId, 10);

  const testWin = makeWindowMock(11, `${DEFAULT_STUDIO_URLS.test}/workspace`);
  const testOk = authorizePrivilegedIpcSender(
    { sender: testWin.webContents, senderFrame: testWin.mainFrame },
    { mainWindow: testWin, channel: 'test' },
  );
  assert.equal(testOk.ok, true);
  assert.equal(testOk.origin, DEFAULT_STUDIO_URLS.test);

  const devWin = makeWindowMock(12, 'http://127.0.0.1:4173/editor');
  const devOk = authorizePrivilegedIpcSender(
    { sender: devWin.webContents, senderFrame: devWin.mainFrame },
    { mainWindow: devWin, channel: 'dev', allowLocalDevLoopback: true },
  );
  assert.equal(devOk.ok, true);
  assert.equal(devOk.origin, 'http://127.0.0.1:4173');

  // Signed config allowedOrigins are intersected with built-in domain scope
  const scoped = resolveAllowedStudioOrigins({
    channel: 'stable',
    allowedOrigins: [
      'https://studio.open-design.ai',
      'https://evil.com',
      DEFAULT_STUDIO_URLS.test,
      'http://127.0.0.1:4173',
    ],
  });
  assert.deepEqual([...scoped], ['https://studio.open-design.ai']);

  // Explicit list containing only out-of-scope origins fails closed
  const failClosed = resolveAllowedStudioOrigins({
    channel: 'stable',
    allowedOrigins: ['https://evil.com'],
  });
  assert.equal(failClosed.size, 0);
});

test('authorizePrivilegedIpcSender denies subframes, popups, login/IdP pages, evil origins, blank pages, and file:// URLs', () => {
  const mainWin = makeWindowMock(100, 'https://motion.open-design.ai/studio');
  const guardOpts = {
    mainWindow: mainWin,
    channel: 'stable',
    allowedOrigins: ['https://motion.open-design.ai'],
  };

  // 1. Subframe / iframe inside main window (even with same origin!)
  const subframeWithParent = {
    url: 'https://motion.open-design.ai/embed',
    parent: mainWin.mainFrame,
    top: mainWin.mainFrame,
  };
  const subframeRes = authorizePrivilegedIpcSender(
    { sender: mainWin.webContents, senderFrame: subframeWithParent },
    guardOpts,
  );
  assert.equal(subframeRes.ok, false);
  assert.equal(subframeRes.error.code, 'UNAUTHORIZED');

  // Detached / non-main frame object with parent=null
  const nonMainFrame = { url: 'https://motion.open-design.ai/studio', parent: null };
  const nonMainRes = authorizePrivilegedIpcSender(
    { sender: mainWin.webContents, senderFrame: nonMainFrame },
    guardOpts,
  );
  assert.equal(nonMainRes.ok, false);
  assert.equal(nonMainRes.error.code, 'UNAUTHORIZED');

  // 2. Popup window / project preview popup (different webContents.id, even on Studio origin!)
  const popupWin = makeWindowMock(200, 'https://motion.open-design.ai/preview');
  const popupRes = authorizePrivilegedIpcSender(
    { sender: popupWin.webContents, senderFrame: popupWin.mainFrame },
    guardOpts,
  );
  assert.equal(popupRes.ok, false);
  assert.equal(popupRes.error.code, 'UNAUTHORIZED');

  // 3. Destroyed main window
  const destroyedRes = authorizePrivilegedIpcSender(
    { sender: mainWin.webContents, senderFrame: mainWin.mainFrame },
    { ...guardOpts, mainWindow: { ...mainWin, isDestroyed: () => true } },
  );
  assert.equal(destroyedRes.ok, false);
  assert.equal(destroyedRes.error.code, 'UNAUTHORIZED');

  // 4. Denied origins on main window main frame: login/IdP, evil, non-Studio subdomain, blank, file://, http downgrade, loopback on stable
  const deniedUrls = [
    'https://accounts.google.com/o/oauth2/v2/auth',
    `https://${'sso.powerformer.com'}/application/o/authorize/`,
    'https://github.com/login/oauth/authorize',
    'https://evil.com/studio',
    'https://motion.open-design.ai.evil.com/studio',
    'https://auth.open-design.ai/login',
    'https://docs.open-design.ai/',
    `${DEFAULT_STUDIO_URLS.test}/studio`,
    'https://user:pass@motion.open-design.ai/studio',
    'http://motion.open-design.ai/studio',
    'http://127.0.0.1:4173/',
    'about:blank',
    'data:text/html,<h1>hi</h1>',
    'blob:https://motion.open-design.ai/1234',
    'file:///Applications/OpenDesign.app/Contents/Resources/splash.html',
    '',
    'not-a-url',
  ];

  for (const url of deniedUrls) {
    const win = makeWindowMock(100, url);
    const res = authorizePrivilegedIpcSender(
      { sender: win.webContents, senderFrame: win.mainFrame },
      { ...guardOpts, mainWindow: win },
    );
    assert.equal(res.ok, false, `Expected denial for URL: ${url}`);
    assert.equal(res.error.code, 'ORIGIN_DENIED', `Expected ORIGIN_DENIED for URL: ${url}`);
  }

  // Wrong loopback port in dev mode
  const wrongPortDevWin = makeWindowMock(12, 'http://127.0.0.1:9999/');
  const wrongPortRes = authorizePrivilegedIpcSender(
    { sender: wrongPortDevWin.webContents, senderFrame: wrongPortDevWin.mainFrame },
    { mainWindow: wrongPortDevWin, channel: 'dev', allowLocalDevLoopback: true },
  );
  assert.equal(wrongPortRes.ok, false);
  assert.equal(wrongPortRes.error.code, 'ORIGIN_DENIED');
});

test('authorizeSplashSender restricts splash channel strictly to retryStartup from local splash.html / retry.html', () => {
  const splashWin = makeWindowMock(55, 'file:///Applications/OpenDesign.app/dist/splash.html?theme=dark');
  const retryWin = makeWindowMock(56, 'file:///Applications/OpenDesign.app/dist/retry.html');

  const okSplash = authorizeSplashSender(
    { sender: splashWin.webContents, senderFrame: splashWin.mainFrame },
    'retryStartup',
    {
      splashWindow: splashWin,
      allowedFilePaths: ['/Applications/OpenDesign.app/dist/splash.html'],
    },
  );
  assert.equal(okSplash.ok, true);
  assert.equal(okSplash.action, 'retryStartup');

  const okRetry = authorizeSplashSender(
    { sender: retryWin.webContents, senderFrame: retryWin.mainFrame },
    'retryStartup',
    { splashWindow: retryWin },
  );
  assert.equal(okRetry.ok, true);

  // Disallowed action
  const badAction = authorizeSplashSender(
    { sender: splashWin.webContents, senderFrame: splashWin.mainFrame },
    'openExternal',
    { splashWindow: splashWin },
  );
  assert.equal(badAction.ok, false);
  assert.equal(badAction.error.code, 'POLICY_DENIED');

  // Wrong window
  const otherWin = makeWindowMock(99, 'file:///Applications/OpenDesign.app/dist/splash.html');
  const wrongWin = authorizeSplashSender(
    { sender: otherWin.webContents, senderFrame: otherWin.mainFrame },
    'retryStartup',
    { splashWindow: splashWin },
  );
  assert.equal(wrongWin.ok, false);
  assert.equal(wrongWin.error.code, 'UNAUTHORIZED');

  // Subframe inside splash window
  const splashSubframe = {
    url: 'file:///Applications/OpenDesign.app/dist/splash.html',
    parent: splashWin.mainFrame,
  };
  const subframeRes = authorizeSplashSender(
    { sender: splashWin.webContents, senderFrame: splashSubframe },
    'retryStartup',
    { splashWindow: splashWin },
  );
  assert.equal(subframeRes.ok, false);
  assert.equal(subframeRes.error.code, 'UNAUTHORIZED');

  // Non-splash file or remote URL or path outside allowedFilePaths
  for (const badUrl of [
    'https://motion.open-design.ai/splash.html',
    'file:///tmp/evil.html',
    'file:///Applications/OpenDesign.app/dist/../splash.html',
    'file:///Applications/OpenDesign.app/dist/%2e%2e/splash.html',
    'file:///other/path/splash.html',
  ]) {
    const win = makeWindowMock(55, badUrl);
    const res = authorizeSplashSender(
      { sender: win.webContents, senderFrame: win.mainFrame },
      'retryStartup',
      {
        splashWindow: win,
        allowedFilePaths: ['/Applications/OpenDesign.app/dist/splash.html'],
      },
    );
    assert.equal(res.ok, false, `Expected splash denial for URL: ${badUrl}`);
    assert.equal(res.error.code, 'ORIGIN_DENIED', `Expected ORIGIN_DENIED for URL: ${badUrl}`);
  }
});

test('desktop/src/preload.ts exposes only the 4-method __OPENMOTION_HOST__ bridge on top-level frames without legacy methods', () => {
  const source = readFileSync(path.join(desktopRoot, 'src', 'preload.ts'), 'utf8');
  assert.match(source, /exposeInMainWorld\('__OPENMOTION_HOST__'/);
  assert.equal(source.includes('__OPENMOTION_DESKTOP__'), false);
  assert.equal(source.includes('openmotion:get-app-info'), false);
  assert.equal(source.includes('openmotion:window-minimize'), false);
  assert.equal(source.includes('openmotion:check-updates'), false);
  assert.match(source, /window\.top === window/);
  assert.match(source, /window\.location/);
  assert.match(source, /fullscreenchange/);
  assert.match(source, /HOST_IPC_CHANNELS\.INFO/);
  assert.match(source, /HOST_IPC_CHANNELS\.CAPABILITIES/);
  assert.match(source, /HOST_IPC_CHANNELS\.INVOKE/);
  assert.match(source, /HOST_IPC_CHANNELS\.EVENT/);
  assert.match(source, /HOST_IPC_CHANNELS\.DOM_FULLSCREEN/);
});

test('shell capabilities expose one canonical name per method and event', () => {
  // The host contract is additive-only: a name listed here is permanent once a
  // stable shell ships it. Add to these lists deliberately, never as an alias.
  const expected = {
    window: {
      methods: [
        'getChromeState',
        'setTheme',
        'minimize',
        'toggleMaximize',
        'close',
        'openExternal',
        'rendererReady',
        'retryStartup',
        'continueToStudio',
        'setTaskProgress',
        'acquireWakeLock',
        'releaseWakeLock',
        'notify',
      ],
      events: ['chromeState', 'menuAction', 'themeChanged', 'focus', 'visibility', 'resizing', 'deepLink'],
    },
    updater: {
      methods: ['getState', 'checkForUpdates', 'downloadUpdate', 'installNow'],
      events: ['state'],
    },
    diagnostics: {
      methods: ['getAppInfo', 'exportBundle', 'openLogsFolder'],
      events: [],
    },
    account: {
      methods: [
        'startBrowserLogin',
        'cancelLogin',
        'getLoginState',
        'openBillingPortal',
        'openInWindowLogin',
        'refresh',
        'signOut',
      ],
      events: ['state'],
    },
    preferences: {
      methods: ['getAll', 'set', 'reset', 'pickDownloadDir', 'relaunch'],
      events: ['changed'],
    },
  };

  const modules = [
    createWindowCapabilityModule({}),
    createUpdaterCapabilityModule({}),
    createDiagnosticsCapabilityModule({}),
    createAccountCapabilityModule({}),
    createPreferencesCapabilityModule({}),
  ];
  const actual = Object.fromEntries(
    modules.map(mod => [mod.name, { methods: Object.keys(mod.methods), events: [...(mod.events ?? [])] }]),
  );
  assert.deepEqual(actual, expected);
});

test('the shell only emits events that the capability declares', () => {
  // Studio discovers events through listCapabilities(); an undeclared or
  // duplicate emit is invisible there and becomes a name nobody agreed to keep.
  const declared = new Map(
    [
      createWindowCapabilityModule({}),
      createUpdaterCapabilityModule({}),
      createDiagnosticsCapabilityModule({}),
      createAccountCapabilityModule({}),
      createPreferencesCapabilityModule({}),
    ].map(mod => [mod.name, new Set(mod.events ?? [])]),
  );
  const srcDir = path.join(desktopRoot, 'src');
  const sources = readdirSync(srcDir)
    .filter(name => name.endsWith('.ts'))
    .map(name => [name, readFileSync(path.join(srcDir, name), 'utf8')]);
  // Capabilities assembled inline (not through a factory) declare their events next to their name.
  for (const [, source] of sources) {
    const inline = /name: HOST_CAPABILITIES\.([A-Z_]+),[^{}]*?events: \[([^\]]*)\]/g;
    for (const match of source.matchAll(inline)) {
      const events = [...match[2].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
      declared.set(HOST_CAPABILITIES[match[1]], new Set(events));
    }
  }

  const emitted = [];
  for (const [name, source] of sources) {
    for (const match of source.matchAll(/\.emit\(\s*HOST_CAPABILITIES\.([A-Z_]+)\s*,\s*['"]([^'"]+)['"]/g)) {
      emitted.push({ file: name, capability: HOST_CAPABILITIES[match[1]], event: match[2] });
    }
  }
  assert.ok(emitted.length >= 10, 'expected to find the shell emit sites');
  const undeclared = emitted.filter(item => !declared.get(item.capability)?.has(item.event));
  assert.deepEqual(undeclared, []);
});
