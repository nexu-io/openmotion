import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveDesktopChrome } from '../../shared/platform-host.ts';
import {
  buildAppIconSvg,
  buildLiquidGlassIconBundle,
  LIQUID_GLASS_ICON_NAME,
  packPngFramesAsIco,
} from '../scripts/build-icons.mjs';
import { DesktopLogger, redactDesktopText } from '../src/logger.ts';
import { buildDesktopDockMenuTemplate, buildDesktopMenuTemplate, DOCS_URL, RELEASES_URL, REPORT_ISSUE_URL } from '../src/menu.ts';
import { buildContextMenuTemplate } from '../src/context-menu.ts';
import { readWindowState, resolveRestoredWindowBounds, writeWindowState } from '../src/window-state.ts';
import {
  buildDesktopChromeCss,
  buildMainWindowOptions,
  getWindowsTitleBarOverlay,
  normalizeDesktopPlatform,
} from '../src/platform.ts';
import { compareSemver, DesktopUpdaterController, resolveElectronAutoUpdater } from '../src/updater.ts';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('resolveDesktopChrome computes safe insets across macOS, Windows, and Linux', () => {
  const macWindowed = resolveDesktopChrome({ platform: 'darwin', fullscreen: false });
  assert.equal(macWindowed.titleBarStyle, 'hiddenInset');
  assert.equal(macWindowed.insetLeft, 78);
  assert.equal(macWindowed.insetRight, 0);
  assert.equal(macWindowed.safeTop, 46);
  assert.equal(macWindowed.customWindowControls, false);

  const macZoomedOut = resolveDesktopChrome({ platform: 'darwin', fullscreen: false, zoomFactor: 0.75 });
  assert.equal(macZoomedOut.insetLeft, 104);
  assert.equal(macZoomedOut.titleBarHeight, 62);
  assert.equal(macZoomedOut.safeTop, 62);

  const macZoomedIn = resolveDesktopChrome({ platform: 'darwin', fullscreen: false, zoomFactor: 1.5 });
  assert.equal(macZoomedIn.insetLeft, 52);
  assert.equal(macZoomedIn.titleBarHeight, 46);

  const macFullscreen = resolveDesktopChrome({ platform: 'darwin', fullscreen: true });
  assert.equal(macFullscreen.insetLeft, 0);
  assert.equal(macFullscreen.safeTop, 0);

  const winWindowed = resolveDesktopChrome({ platform: 'win32', fullscreen: false, maximized: true });
  assert.equal(winWindowed.titleBarStyle, 'hiddenOverlay');
  assert.equal(winWindowed.insetLeft, 0);
  assert.equal(winWindowed.insetRight, 138);
  assert.equal(winWindowed.safeTop, 46);
  assert.equal(winWindowed.maximized, true);

  const winZoomedOut = resolveDesktopChrome({ platform: 'win32', fullscreen: false, zoomFactor: 0.75 });
  assert.equal(winZoomedOut.insetRight, 184);
  assert.equal(winZoomedOut.titleBarHeight, 62);

  const winFullscreen = resolveDesktopChrome({ platform: 'win32', fullscreen: true });
  assert.equal(winFullscreen.insetRight, 0);
  assert.equal(winFullscreen.safeTop, 0);

  const linuxCustom = resolveDesktopChrome({ platform: 'linux', fullscreen: false });
  assert.equal(linuxCustom.titleBarStyle, 'custom');
  assert.equal(linuxCustom.customWindowControls, true);
  assert.equal(linuxCustom.insetRight, 0);
  assert.equal(linuxCustom.safeTop, 46);

  const linuxNative = resolveDesktopChrome({ platform: 'linux', linuxCustomTitleBar: false });
  assert.equal(linuxNative.titleBarStyle, 'native');
  assert.equal(linuxNative.customWindowControls, false);
  assert.equal(linuxNative.insetRight, 0);
  assert.equal(linuxNative.safeTop, 0);
});

test('buildMainWindowOptions enforces hardened preload and OS title bar chrome', () => {
  const mac = buildMainWindowOptions({
    platform: 'darwin',
    theme: 'dark',
    preloadPath: '/app/preload.cjs',
  });
  assert.equal(mac.titleBarStyle, 'hiddenInset');
  assert.deepEqual(mac.trafficLightPosition, { x: 16, y: 17 });
  assert.equal(mac.minWidth, 480);
  assert.equal(mac.minHeight, 480);
  assert.equal(mac.webPreferences?.contextIsolation, true);
  assert.equal(mac.webPreferences?.nodeIntegration, false);
  assert.equal(mac.webPreferences?.sandbox, true);
  assert.equal(mac.webPreferences?.v8CacheOptions, 'bypassHeatCheck');
  assert.equal(mac.webPreferences?.backgroundThrottling, true);

  const winLight = buildMainWindowOptions({
    platform: 'win32',
    theme: 'light',
    preloadPath: '/app/preload.cjs',
  });
  assert.equal(winLight.titleBarStyle, 'hidden');
  assert.deepEqual(winLight.titleBarOverlay, getWindowsTitleBarOverlay('light'));

  const linux = buildMainWindowOptions({
    platform: 'linux',
    linuxCustomTitleBar: true,
    preloadPath: '/app/preload.cjs',
  });
  assert.equal(linux.frame, false);
  assert.equal(normalizeDesktopPlatform('freebsd'), 'linux');
});

test('buildDesktopChromeCss enforces traffic-light safe insets across windowed, fullscreen, and non-Studio pages', () => {
  const macWindowedCss = buildDesktopChromeCss(resolveDesktopChrome({ platform: 'darwin', fullscreen: false }));
  assert.match(macWindowedCss, /--om-desktop-inset-left:\s*78px/);
  assert.match(macWindowedCss, /--om-desktop-safe-top:\s*46px/);
  assert.match(macWindowedCss, /\.om-gallery-surface:not\(\[data-workspace-gallery\]\).*\.om-game-project/);
  assert.match(macWindowedCss, /html\[data-motion-studio\] \.om-app-header/);
  assert.match(macWindowedCss, /user-select:\s*none;/);
  assert.match(macWindowedCss, /-webkit-user-drag:\s*none;/);
  assert.match(macWindowedCss, /padding-inline-start:\s*calc\(var\(--motion-space-8, 8px\) \+ 78px\)/);
  assert.match(macWindowedCss, /html\[data-motion-studio\] \.om-application\s*\{\s*display:\s*flex;\s*flex-direction:\s*column;/);
  assert.match(macWindowedCss, /html\[data-motion-studio\] \.om-application > \.om-app-header\s*\{\s*flex:\s*0 0 46px;\s*order:\s*0;/);
  assert.match(macWindowedCss, /@media \(max-width: 860px\)/);
  assert.match(macWindowedCss, /\.om-app-header-links\s*\{\s*display:\s*none;/);
  assert.match(macWindowedCss, /justify-content:\s*flex-start;/);
  assert.match(macWindowedCss, /html:not\(\[data-motion-studio\]\) body \{\s*box-sizing:\s*border-box;\s*padding-top:\s*46px;/);
  assert.match(macWindowedCss, /html\[data-om-resizing="true"\]/);
  assert.match(macWindowedCss, /transition-duration:\s*0s !important;/);
  assert.match(macWindowedCss, /pointer-events:\s*none !important;/);

  const macFullscreenCss = buildDesktopChromeCss(resolveDesktopChrome({ platform: 'darwin', fullscreen: true }));
  assert.match(macFullscreenCss, /--om-desktop-inset-left:\s*0px/);
  assert.match(macFullscreenCss, /padding-inline-start:\s*calc\(var\(--motion-space-8, 8px\) \+ 0px\)/);
  assert.doesNotMatch(macFullscreenCss, /html:not\(\[data-motion-studio\]\) body/);

  const winWindowedCss = buildDesktopChromeCss(resolveDesktopChrome({ platform: 'win32', fullscreen: false }));
  assert.match(winWindowedCss, /--om-desktop-inset-right:\s*138px/);

  const nativeCss = buildDesktopChromeCss(resolveDesktopChrome({ platform: 'linux', linuxCustomTitleBar: false }));
  assert.equal(nativeCss, '');
});

test('DesktopLogger redacts credentials/paths, rotates logs, and records crash markers', () => {
  const logDir = path.join(os.tmpdir(), `om-desktop-log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  try {
    const sampleHome = path.join(os.tmpdir(), 'custom-user-home');
    const redacted = redactDesktopText(
      `Bearer secret-jwt-token-value om_mcp_1234567890abcdef ${path.join(sampleHome, 'project')}`,
      [sampleHome],
    );
    assert.equal(redacted.includes('secret-jwt-token-value'), false);
    assert.equal(redacted.includes('1234567890abcdef'), false);
    assert.equal(redacted.includes('custom-user-home'), false);
    assert.ok(redacted.includes('<REDACTED_PATH>'));

    const logger = new DesktopLogger({
      logDir,
      maxBytes: 180,
      maxFiles: 2,
      redactPaths: [sampleHome],
    });
    assert.deepEqual(
      logger.markSessionStarted({ version: '1.2.3', platform: 'darwin', arch: 'arm64' }),
      { previousExitUnclean: false },
    );

    for (let i = 0; i < 12; i++) {
      logger.info('main', `Entry ${i} token=om_brg_abcdefghijklmnop`);
    }
    assert.ok(existsSync(path.join(logDir, 'main.log')));
    assert.ok(existsSync(path.join(logDir, 'main.log.1')));
    const mainContent = readFileSync(path.join(logDir, 'main.log'), 'utf8');
    assert.equal(mainContent.includes('abcdefghijklmnop'), false);

    // Simulating a second boot while active=true triggers crash-marker creation.
    assert.deepEqual(
      logger.markSessionStarted({ version: '1.2.4', platform: 'darwin', arch: 'arm64' }),
      { previousExitUnclean: true, previousVersion: '1.2.3' },
    );
    assert.ok(existsSync(path.join(logDir, 'crash-marker.json')));
    const marker = JSON.parse(readFileSync(path.join(logDir, 'crash-marker.json'), 'utf8'));
    assert.equal(marker.reason, 'unclean-previous-exit');

    logger.markSessionEnded('clean-exit');
    const session = JSON.parse(readFileSync(path.join(logDir, 'session-state.json'), 'utf8'));
    assert.equal(session.active, false);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('buildDesktopMenuTemplate wires Check Updates, Export Logs, Report Issue, and Community actions without restricted links', () => {
  const actions = [];
  const urls = [];

  for (const platform of ['darwin', 'win32', 'linux']) {
    actions.length = 0;
    urls.length = 0;
    const template = buildDesktopMenuTemplate({
      platform,
      appVersion: '0.1.0',
      onAction: action => actions.push(action),
      onOpenUrl: url => urls.push(url),
    });

    const flatItems = template.flatMap(group =>
      Array.isArray(group.submenu) ? group.submenu : [],
    );
    const findLabel = needle =>
      flatItems.find(item => typeof item.label === 'string' && item.label.includes(needle));

    assert.ok(findLabel('Check for Updates'), `Missing updates menu on ${platform}`);
    assert.ok(findLabel('Export Diagnostic Logs'), `Missing export logs menu on ${platform}`);
    assert.ok(findLabel('Report an Issue'), `Missing report issue menu on ${platform}`);
    assert.ok(findLabel('Feishu'), `Missing Feishu community menu on ${platform}`);
    assert.ok(findLabel('Discord'), `Missing Discord community menu on ${platform}`);

    findLabel('Check for Updates')?.click?.({}, undefined, {});
    findLabel('Export Diagnostic Logs')?.click?.({}, undefined, {});
    findLabel('Feishu')?.click?.({}, undefined, {});
    findLabel('Report an Issue')?.click?.({}, undefined, {});
    findLabel('Documentation')?.click?.({}, undefined, {});
    findLabel("What's New")?.click?.({}, undefined, {});

    assert.deepEqual(actions, ['check-updates', 'export-logs', 'join-community-feishu']);
    assert.deepEqual(urls, [REPORT_ISSUE_URL, DOCS_URL, RELEASES_URL]);
  }

  // Ensure desktop source never embeds external Feishu links directly.
  const menuSource = readFileSync(path.join(desktopRoot, 'src', 'menu.ts'), 'utf8');
  assert.equal(menuSource.includes('feishu.cn'), false);
});

test('buildDesktopMenuTemplate follows macOS HIG standard roles, localization, Dock menu, and production dev-item gating', () => {
  const macProd = buildDesktopMenuTemplate({
    platform: 'darwin',
    appVersion: '0.2.1',
    locale: 'en-US',
    includeDevItems: false,
    onAction: () => {},
    onOpenUrl: () => {},
  });
  const macFlat = macProd.flatMap(group => (Array.isArray(group.submenu) ? group.submenu : []));

  assert.ok(macFlat.some(item => item.role === 'about'), 'macOS app menu should use native About role');
  assert.ok(macFlat.some(item => item.role === 'hide'), 'macOS app menu should bind Cmd+H via hide role');
  assert.ok(macFlat.some(item => item.role === 'hideOthers'), 'macOS app menu should include hideOthers');
  assert.ok(macFlat.some(item => item.role === 'quit'), 'macOS app menu should bind Cmd+Q via quit role');
  assert.ok(macFlat.some(item => item.role === 'close'), 'macOS File menu should bind Cmd+W via close role');
  assert.ok(macFlat.some(item => item.role === 'minimize'), 'macOS Window menu should bind Cmd+M via minimize role');
  assert.ok(macFlat.some(item => item.role === 'zoom'), 'macOS Window menu should include zoom role for window tiling');
  assert.equal(macFlat.some(item => item.role === 'toggleDevTools'), false, 'Production menu hides DevTools');
  assert.equal(macFlat.some(item => item.role === 'forceReload'), false, 'Production menu hides Force Reload');

  const macDev = buildDesktopMenuTemplate({
    platform: 'darwin',
    appVersion: '0.2.1',
    locale: 'zh-CN',
    includeDevItems: true,
    onAction: () => {},
    onOpenUrl: () => {},
  });
  const macDevFlat = macDev.flatMap(group => (Array.isArray(group.submenu) ? group.submenu : []));
  assert.ok(macDevFlat.some(item => item.role === 'toggleDevTools'), 'Dev menu includes DevTools');
  assert.ok(macDevFlat.some(item => item.label === '检查更新…'), 'zh-CN locale localizes custom menu labels');
  assert.ok(macDevFlat.some(item => item.label === '新建项目'), 'zh-CN locale localizes File menu labels');

  const dockActions = [];
  let focused = 0;
  const dockMenu = buildDesktopDockMenuTemplate({
    locale: 'zh-CN',
    onAction: action => dockActions.push(action),
    onFocusMainWindow: () => {
      focused += 1;
    },
  });
  dockMenu.find(item => item.label === '打开工作区')?.click?.({}, undefined, {});
  dockMenu.find(item => item.label === '新建项目')?.click?.({}, undefined, {});
  assert.equal(focused, 1);
  assert.deepEqual(dockActions, ['new-project']);
});

test('window-state persists bounds safely and clamps disconnected display coordinates', () => {
  const workAreas = [{ x: 0, y: 25, width: 1512, height: 957 }];
  const defaults = { width: 1440, height: 920, minWidth: 480, minHeight: 480 };

  const inBounds = resolveRestoredWindowBounds(
    { x: 120, y: 80, width: 1200, height: 800, maximized: false },
    workAreas,
    defaults,
  );
  assert.deepEqual(inBounds, { bounds: { x: 120, y: 80, width: 1200, height: 800 }, maximized: false });

  const offScreen = resolveRestoredWindowBounds(
    { x: 3200, y: 100, width: 1200, height: 800, maximized: true },
    workAreas,
    defaults,
  );
  assert.equal(offScreen.bounds.x, undefined);
  assert.equal(offScreen.bounds.y, undefined);
  assert.equal(offScreen.bounds.width, 1200);
  assert.equal(offScreen.maximized, true);

  // Small primary laptop display + large secondary external display:
  // restoring a large window positioned on the secondary monitor must NOT be shrunk to the primary display.
  const multiDisplay = [
    { x: 0, y: 25, width: 1280, height: 775 },
    { x: 1280, y: 0, width: 2560, height: 1440 },
  ];
  const onExternal = resolveRestoredWindowBounds(
    { x: 1400, y: 80, width: 1920, height: 1100, maximized: false },
    multiDisplay,
    defaults,
  );
  assert.deepEqual(onExternal, {
    bounds: { x: 1400, y: 80, width: 1920, height: 1100 },
    maximized: false,
  });

  const tmpDir = path.join(os.tmpdir(), `om-win-state-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const statePath = path.join(tmpDir, 'window-state.json');
  try {
    assert.equal(
      writeWindowState(statePath, { version: 1, x: 40, y: 60, width: 1280, height: 820, maximized: false }),
      true,
    );
    const loaded = readWindowState(statePath);
    assert.deepEqual(loaded, { version: 1, x: 40, y: 60, width: 1280, height: 820, maximized: false });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildContextMenuTemplate builds native macOS context menus and rejects unsafe links', () => {
  const empty = buildContextMenuTemplate(
    {
      isEditable: false,
      selectionText: '',
      linkURL: '',
      misspelledWord: '',
      dictionarySuggestions: [],
      editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false },
    },
    { platform: 'darwin', locale: 'zh-CN' },
  );
  assert.deepEqual(empty, []);

  let replaced = '';
  let lookedUp = 0;
  let openedUrl = '';
  const editable = buildContextMenuTemplate(
    {
      isEditable: true,
      selectionText: 'teh',
      linkURL: 'https://open-design.ai/docs',
      misspelledWord: 'teh',
      dictionarySuggestions: ['the'],
      editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false },
    },
    {
      platform: 'darwin',
      locale: 'zh-CN',
      onReplaceMisspelling: s => {
        replaced = s;
      },
      onLookUpSelection: () => {
        lookedUp += 1;
      },
      onOpenLinkExternal: url => {
        openedUrl = url;
      },
    },
  );
  editable.find(item => item.label === 'the')?.click?.({}, undefined, {});
  editable.find(item => typeof item.label === 'string' && item.label.startsWith('查询'))?.click?.({}, undefined, {});
  editable.find(item => item.label === '在浏览器中打开链接')?.click?.({}, undefined, {});
  assert.equal(replaced, 'the');
  assert.equal(lookedUp, 1);
  assert.equal(openedUrl, 'https://open-design.ai/docs');

  const unsafeLink = buildContextMenuTemplate(
    {
      isEditable: false,
      selectionText: '',
      linkURL: 'javascript:alert(1)',
      misspelledWord: '',
      dictionarySuggestions: [],
      editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false },
    },
    { platform: 'darwin', locale: 'en-US' },
  );
  assert.deepEqual(unsafeLink, []);
});

test('DesktopUpdaterController transitions cleanly and runs beforeQuit hook before quitAndInstall', async () => {
  const unpackaged = new DesktopUpdaterController({ currentVersion: '0.1.0', isPackaged: false });
  const unsupported = await unpackaged.checkForUpdates();
  assert.equal(unsupported.status, 'unsupported');

  const handlers = new Map();
  let quitAndInstallCalled = false;
  let beforeQuitDone = false;
  let configuredFeed = null;

  const packaged = new DesktopUpdaterController({
    currentVersion: '0.1.0',
    isPackaged: true,
    channel: 'stable',
    loadAutoUpdater: async () => ({
      autoDownload: true,
      autoInstallOnAppQuit: true,
      setFeedURL(feed) {
        configuredFeed = feed;
      },
      on(event, fn) {
        handlers.set(event, fn);
      },
      async checkForUpdates() {
        handlers.get('checking-for-update')?.();
        handlers.get('update-available')?.({ version: '0.2.0' });
      },
      async downloadUpdate() {
        handlers.get('download-progress')?.({ percent: 55.4 });
        handlers.get('update-downloaded')?.({ version: '0.2.0' });
      },
      quitAndInstall() {
        assert.equal(beforeQuitDone, true, 'beforeQuit hook must complete before quitAndInstall');
        quitAndInstallCalled = true;
      },
    }),
  });

  const avail = await packaged.checkForUpdates();
  assert.equal(avail.status, 'available');
  assert.equal(avail.availableVersion, '0.2.0');
  assert.equal(configuredFeed?.provider, 'generic');

  const downloaded = await packaged.downloadUpdate();
  assert.equal(downloaded.status, 'downloaded');
  assert.equal(downloaded.progress, 100);

  const installRes = await packaged.installUpdateNow(async () => {
    beforeQuitDone = true;
  });
  assert.equal(installRes.ok, true);
  assert.equal(quitAndInstallCalled, true);
});

test('DesktopUpdaterController resolves CJS default autoUpdater export and reports error without GitHub fallback when feed is missing', async () => {
  const fakeAutoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    setFeedURL() {},
    on() {},
    async checkForUpdates() {
      throw new Error('HttpError: 404 "Cannot find latest-mac.yml"');
    },
    async downloadUpdate() {},
    quitAndInstall() {},
  };

  assert.equal(resolveElectronAutoUpdater({ default: { autoUpdater: fakeAutoUpdater } }), fakeAutoUpdater);
  assert.equal(resolveElectronAutoUpdater({ autoUpdater: fakeAutoUpdater }), fakeAutoUpdater);

  assert.equal(compareSemver('v0.2.1', '0.2.1'), 0);
  assert.ok(compareSemver('0.2.2', '0.2.1') > 0);
  assert.ok(compareSemver('0.2.1', '0.2.1-beta.1') > 0);

  const missing = new DesktopUpdaterController({
    currentVersion: '0.2.1',
    isPackaged: true,
    channel: 'stable',
    loadAutoUpdater: async () => fakeAutoUpdater,
  });
  const resMissing = await missing.checkForUpdates();
  assert.equal(resMissing.status, 'error');
  assert.ok(resMissing.message);
});

test('splash.html uses pure inline vector SVG animation and thin-shell omits legacy thick-shell sidecar/staging files', () => {
  const splashHtml = readFileSync(path.join(desktopRoot, 'src', 'splash.html'), 'utf8');
  assert.match(splashHtml, /id="retry-btn"/);
  assert.match(splashHtml, /id="export-logs-btn"/);
  assert.match(splashHtml, /prefers-reduced-motion/);
  assert.match(splashHtml, /class="od-wordmark-svg"/);
  assert.match(splashHtml, /id="od-wordmark-mask"/);
  assert.equal(splashHtml.includes('<canvas'), false, 'Splash should use pure vector SVG without raster canvas/WebGL blur');
  assert.match(splashHtml, /function teardownSplashResources/);

  assert.equal(
    existsSync(path.join(desktopRoot, 'src', 'sidecar.ts')),
    false,
    'Thin-shell desktop must not carry legacy local Node sidecar',
  );
  assert.equal(
    existsSync(path.join(desktopRoot, 'scripts', 'stage-app.mjs')),
    false,
    'Thin-shell desktop must not carry legacy backend app-server staging script',
  );
});

test('buildAppIconSvg, buildLiquidGlassIconBundle, and packPngFramesAsIco produce valid multi-platform outputs', () => {
  const brandSvg = path.resolve(desktopRoot, '..', 'packages', 'design-system', 'brand', 'loading-mark.svg');
  const iconSvg = buildAppIconSvg(brandSvg);
  assert.match(iconSvg, /viewBox="0 0 1024 1024"/);
  assert.match(iconSvg, /#00e608|#58ff5e/);

  const tmpIconDir = path.join(os.tmpdir(), `om-liquid-glass-test-${Date.now()}`, `${LIQUID_GLASS_ICON_NAME}.icon`);
  try {
    const { iconDir, iconManifest } = buildLiquidGlassIconBundle(brandSvg, tmpIconDir);
    assert.ok(existsSync(path.join(iconDir, 'icon.json')));
    assert.ok(existsSync(path.join(iconDir, 'Assets', 'aura.svg')));
    assert.ok(existsSync(path.join(iconDir, 'Assets', 'ring.svg')));
    assert.ok(existsSync(path.join(iconDir, 'Assets', 'arrow.svg')));
    assert.equal(iconManifest['supported-platforms']?.squares, 'shared');
    assert.ok(Array.isArray(iconManifest['fill-specializations']));
    assert.ok(iconManifest['fill-specializations'].some(spec => spec.appearance === 'dark'));
    const glassGroup = iconManifest.groups.find(group => group.specular === true);
    assert.ok(glassGroup);
    assert.ok(glassGroup.layers.every(layer => layer.glass === true));
  } finally {
    rmSync(path.dirname(tmpIconDir), { recursive: true, force: true });
  }

  const builderConfig = readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
  assert.match(builderConfig, /CFBundleIconName:\s*AppIcon/);
  assert.match(builderConfig, /-\s*Assets\.car/);

  const fakePng16 = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]);
  const fakePng256 = Buffer.from([137, 80, 78, 71, 5, 6, 7, 8, 9]);
  const ico = packPngFramesAsIco([
    { size: 16, data: fakePng16 },
    { size: 256, data: fakePng256 },
  ]);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico.readUInt8(6), 16);
  assert.equal(ico.readUInt8(6 + 16), 0);
});
