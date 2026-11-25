import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_STUDIO_URLS } from '../../shared/desktop-builtin-rules.ts';
import {
  DesktopEnvironmentStore,
  describeDesktopEnvironment,
  extractStudioUrlFromArgv,
  isEnvironmentSwitcherEnabled,
  parseExtraAllowedEnvDomains,
  readDesktopEnvironmentState,
  resolveEnvironmentSessionPartition,
  validateTestEnvironmentUrl,
  writeDesktopEnvironmentState,
} from '../src/env-switcher.ts';
import {
  authorizeEnvSwitcherSender,
  authorizePrivilegedIpcSender,
} from '../src/ipc-guard.ts';
import {
  evaluateNavigationPolicy,
  evaluateWindowOpenPolicy,
} from '../src/window-policy.ts';
import { parseDesktopDeepLink } from '../src/protocol.ts';
import { buildDesktopMenuTemplate } from '../src/menu.ts';

const TEST_STUDIO_ORIGIN = DEFAULT_STUDIO_URLS.test;
const TEST_STUDIO_HOST = new URL(TEST_STUDIO_ORIGIN).host;
const laneUrl = sub => `https://${sub}.${TEST_STUDIO_HOST}`;
const EXTRA_LANE_ROOT = 'lanes.example-internal.test';

test('stable channel disables environment switching across validation, argv, store, and deep links', () => {
  assert.equal(isEnvironmentSwitcherEnabled('stable'), false);
  assert.equal(isEnvironmentSwitcherEnabled('test'), true);
  assert.equal(isEnvironmentSwitcherEnabled('dev'), true);

  const stableCheck = validateTestEnvironmentUrl(TEST_STUDIO_ORIGIN, {
    channel: 'stable',
  });
  assert.equal(stableCheck.ok, false);

  const stableArgv = extractStudioUrlFromArgv(
    ['OpenDesign', `--studio-url=${TEST_STUDIO_ORIGIN}`],
    { channel: 'stable' },
  );
  assert.equal(stableArgv, undefined);

  const stableDeepLink = parseDesktopDeepLink(
    `openmotion://open?env=${encodeURIComponent(TEST_STUDIO_ORIGIN)}`,
    { allowEnvParam: true, channel: 'stable' },
  );
  assert.equal(stableDeepLink.ok, false);
  assert.equal(stableDeepLink.reason, 'untrusted-parameter');

  const stableSwitcherAuth = authorizeEnvSwitcherSender(null, {
    channel: 'stable',
    envSwitcherWindow: null,
  });
  assert.equal(stableSwitcherAuth.ok, false);
  assert.equal(stableSwitcherAuth.error.code, 'POLICY_DENIED');
});

test('test/dev URL validation accepts test domains, pluggable Orbit domains, and loopback while rejecting untrusted hosts', () => {
  assert.deepEqual(
    validateTestEnvironmentUrl(`${laneUrl('pr-482')}/settings`, {
      channel: 'test',
    }),
    {
      ok: true,
      normalizedUrl: laneUrl('pr-482'),
      origin: laneUrl('pr-482'),
      isLoopback: false,
    },
  );

  assert.deepEqual(
    validateTestEnvironmentUrl('http://127.0.0.1:4173/settings/general', {
      channel: 'test',
    }),
    {
      ok: true,
      normalizedUrl: 'http://127.0.0.1:4173',
      origin: 'http://127.0.0.1:4173',
      isLoopback: true,
    },
  );

  // Future Orbit lane root domains plug in cleanly via extraAllowedDomains.
  const extraDomains = parseExtraAllowedEnvDomains(`${EXTRA_LANE_ROOT}, preview.openmotion.internal`);
  const laneCheck = validateTestEnvironmentUrl(`https://pr-99.${EXTRA_LANE_ROOT}`, {
    channel: 'test',
    extraAllowedDomains: extraDomains,
  });
  assert.equal(laneCheck.ok, true);
  assert.equal(laneCheck.origin, `https://pr-99.${EXTRA_LANE_ROOT}`);

  // Untrusted hosts, non-loopback HTTP, and credentials are rejected.
  assert.equal(validateTestEnvironmentUrl('https://evil.example.com', { channel: 'test' }).ok, false);
  assert.equal(validateTestEnvironmentUrl(`http://${TEST_STUDIO_HOST}`, { channel: 'test' }).ok, false);
  assert.equal(validateTestEnvironmentUrl(`https://user:pass@${TEST_STUDIO_HOST}`, { channel: 'test' }).ok, false);
  assert.equal(validateTestEnvironmentUrl('javascript:alert(1)', { channel: 'test' }).ok, false);
});

test('session partitions isolate custom lanes and local loopback while keeping default session for base test', () => {
  const defaultTest = TEST_STUDIO_ORIGIN;
  assert.equal(resolveEnvironmentSessionPartition(defaultTest, defaultTest), undefined);

  const laneA = resolveEnvironmentSessionPartition(
    laneUrl('pr-101'),
    defaultTest,
  );
  const laneB = resolveEnvironmentSessionPartition(
    laneUrl('pr-102'),
    defaultTest,
  );
  const local = resolveEnvironmentSessionPartition('http://127.0.0.1:4173', defaultTest);

  assert.match(laneA ?? '', /^persist:om-env-[0-9a-f]{12}$/);
  assert.match(laneB ?? '', /^persist:om-env-[0-9a-f]{12}$/);
  assert.match(local ?? '', /^persist:om-env-[0-9a-f]{12}$/);
  assert.notEqual(laneA, laneB);
  assert.notEqual(laneA, local);

  const laneDesc = describeDesktopEnvironment(laneUrl('pr-482'), {
    channel: 'test',
    defaultUrl: defaultTest,
  });
  assert.equal(laneDesc.badge, 'PR-482');
  assert.equal(laneDesc.isCustomOverride, true);

  const localDesc = describeDesktopEnvironment('http://127.0.0.1:4173', {
    channel: 'test',
    defaultUrl: defaultTest,
  });
  assert.equal(localDesc.badge, 'LOCAL :4173');
  assert.equal(localDesc.isLoopback, true);
  assert.equal(localDesc.isCustomOverride, true);
});

test('DesktopEnvironmentStore persists override and recent list safely and refuses symlinks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmotion-env-'));
  const filePath = path.join(dir, 'dev-env.json');
  try {
    const opts = { channel: 'test' };
    const store = new DesktopEnvironmentStore(filePath, opts);
    assert.deepEqual(store.get(), { overrideUrl: null, recent: [] });

    const setLocal = store.setOverride('http://127.0.0.1:4173/settings', '2026-11-23T00:00:00.000Z');
    assert.equal(setLocal.ok, true);
    const setLane = store.setOverride(laneUrl('pr-482'), '2026-11-23T00:01:00.000Z');
    assert.equal(setLane.ok, true);

    const reloaded = readDesktopEnvironmentState(filePath, opts);
    assert.equal(reloaded.overrideUrl, laneUrl('pr-482'));
    assert.deepEqual(
      reloaded.recent.map(item => item.url),
      [laneUrl('pr-482'), 'http://127.0.0.1:4173'],
    );

    store.reset();
    assert.equal(readDesktopEnvironmentState(filePath, opts).overrideUrl, null);
    assert.equal(readDesktopEnvironmentState(filePath, opts).recent.length, 2);

    // Symlink target is refused.
    const realFile = path.join(dir, 'real.json');
    const linkFile = path.join(dir, 'link.json');
    fs.writeFileSync(realFile, '{"overrideUrl":"http://127.0.0.1:4173","recent":[]}\n');
    fs.symlinkSync(realFile, linkFile);
    assert.deepEqual(readDesktopEnvironmentState(linkFile, opts), { overrideUrl: null, recent: [] });
    assert.equal(writeDesktopEnvironmentState(linkFile, { overrideUrl: 'http://127.0.0.1:4173', recent: [] }, opts), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicitTestStudioOrigin authorizes user-selected loopback on test channel only', () => {
  const frame = { url: 'http://127.0.0.1:4173/settings/general', parent: null, top: null };
  const wc = { id: 42, mainFrame: frame, isDestroyed: () => false };
  const mainWin = { webContents: wc, isDestroyed: () => false };
  const event = { sender: wc, senderFrame: frame };

  // Authorized on `test` when matching explicitTestStudioOrigin.
  const testOk = authorizePrivilegedIpcSender(event, {
    mainWindow: mainWin,
    channel: 'test',
    studioUrl: 'http://127.0.0.1:4173',
    explicitTestStudioOrigin: 'http://127.0.0.1:4173',
  });
  assert.equal(testOk.ok, true);

  // Denied for a different loopback port.
  const wrongPort = authorizePrivilegedIpcSender(event, {
    mainWindow: mainWin,
    channel: 'test',
    studioUrl: 'http://127.0.0.1:5173',
    explicitTestStudioOrigin: 'http://127.0.0.1:5173',
  });
  assert.equal(wrongPort.ok, false);
  assert.equal(wrongPort.error.code, 'ORIGIN_DENIED');

  // Always denied on `stable` even if explicitTestStudioOrigin were somehow passed.
  const stableDenied = authorizePrivilegedIpcSender(event, {
    mainWindow: mainWin,
    channel: 'stable',
    studioUrl: 'http://127.0.0.1:4173',
    explicitTestStudioOrigin: 'http://127.0.0.1:4173',
  });
  assert.equal(stableDenied.ok, false);
  assert.equal(stableDenied.error.code, 'ORIGIN_DENIED');

  // Navigation & popup policies allow matching explicit test loopback with hardened popups.
  const nav = evaluateNavigationPolicy('http://127.0.0.1:4173/projects', {
    studioOrigin: 'http://127.0.0.1:4173',
    channel: 'test',
    explicitTestStudioOrigin: 'http://127.0.0.1:4173',
  });
  assert.equal(nav.action, 'allow');

  const popup = evaluateWindowOpenPolicy('http://127.0.0.1:4173/preview', {
    studioOrigin: 'http://127.0.0.1:4173',
    channel: 'test',
    explicitTestStudioOrigin: 'http://127.0.0.1:4173',
  });
  assert.equal(popup.action, 'allow');
  assert.equal(popup.overrideBrowserWindowOptions.webPreferences.preload, undefined);
});

test('deep link env parameter works on test channel with validation and menu omits Environment on stable', () => {
  const validDeepLink = parseDesktopDeepLink(
    `openmotion://open?env=${encodeURIComponent(laneUrl('pr-482'))}&path=%2Fsettings%2Fgeneral`,
    { allowEnvParam: true, channel: 'test' },
  );
  assert.equal(validDeepLink.ok, true);
  assert.equal(validDeepLink.params.env, laneUrl('pr-482'));
  assert.equal(validDeepLink.params.path, '/settings/general');

  const evilDeepLink = parseDesktopDeepLink(
    'openmotion://open?env=https%3A%2F%2Fevil.example.com',
    { allowEnvParam: true, channel: 'test' },
  );
  assert.equal(evilDeepLink.ok, false);
  assert.equal(evilDeepLink.reason, 'invalid-parameter-value');

  // Menu without `environment` (stable) omits Environment menu.
  const stableMenu = buildDesktopMenuTemplate({
    platform: 'darwin',
    appVersion: '0.2.1',
    locale: 'en',
    onAction: () => {},
    onOpenUrl: () => {},
  });
  assert.equal(stableMenu.some(item => item.label === 'Environment'), false);

  // Menu with `environment` (test/dev) includes Environment menu and switcher shortcut.
  const testMenu = buildDesktopMenuTemplate({
    platform: 'darwin',
    appVersion: '0.2.1',
    locale: 'zh-CN',
    environment: {
      activeLabel: 'Local (127.0.0.1:4173)',
      activeUrl: 'http://127.0.0.1:4173',
      isCustomOverride: true,
      presets: [
        { label: 'Test Default', url: TEST_STUDIO_ORIGIN, active: false },
        { label: 'Local Dev', url: 'http://127.0.0.1:4173', active: true },
      ],
      recent: [
        { label: 'PR-482', url: laneUrl('pr-482'), active: false },
      ],
      onSelectUrl: () => {},
      onOpenSwitcher: () => {},
      onResetDefault: () => {},
      onClearEnvironmentData: () => {},
      onCopyEnvironmentInfo: () => {},
    },
    onAction: () => {},
    onOpenUrl: () => {},
  });
  const envMenu = testMenu.find(item => item.label === '测试环境');
  assert.ok(envMenu && Array.isArray(envMenu.submenu));
  assert.ok(envMenu.submenu.some(item => item.accelerator === 'CmdOrCtrl+Shift+E'));
  assert.ok(envMenu.submenu.some(item => item.label === '恢复默认环境' && item.enabled === true));
});
