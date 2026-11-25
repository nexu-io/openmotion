import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DESKTOP_DOWNLOAD_URL,
  DEFAULT_STUDIO_URLS,
  DEFAULT_UPDATE_BASE_URL,
} from '../../shared/desktop-builtin-rules.ts';
import { validateSignedConfigPayloadBounds } from '../../shared/signed-config.ts';
import { generateEd25519KeyPair } from '../../packages/signed-config/index.ts';
import { injectBundleDebugId, resolveBuildTrustAnchors } from '../scripts/build.mjs';
import {
  buildDesktopReleaseCardPayload,
  formatStructuredReleaseChangelog,
  sendFeishuReleaseNotification,
  signFeishuWebhook,
  validateFeishuWebhookUrl,
} from '../scripts/notify-feishu-release.mjs';
import { resolveDesktopReleaseVersion } from '../scripts/resolve-release-version.mjs';
import {
  compareSemver,
  DesktopUpdaterController,
  normalizeSemver,
  normalizeUpdateChannel,
  resolveElectronAutoUpdater,
  resolvePackagedReleaseChannel,
  resolveUpdateFeedConfig,
  sanitizeReleaseNotes,
} from '../src/updater.ts';
import { resolveUpdaterMenuPresentation } from '../src/ux-controllers.ts';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(testsDir, '..');
const repoRoot = path.resolve(desktopRoot, '..');
const TEST_STUDIO_ORIGIN = DEFAULT_STUDIO_URLS.test;
const TEST_STUDIO_HOST = new URL(TEST_STUDIO_ORIGIN).host;
const FEISHU_BOT_HOST = 'open.feishu.cn';
const TEST_FEISHU_WEBHOOK_URL = `https://${FEISHU_BOT_HOST}/open-apis/bot/v2/hook/test-hook-id`;
const HTTP_FEISHU_WEBHOOK_URL = `http://${FEISHU_BOT_HOST}/open-apis/bot/v2/hook/abc`;

function createFakeAutoUpdater(overrides = {}) {
  const handlers = new Map();
  const feedCalls = [];
  let quitAndInstallArgs = null;

  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: null,
    setFeedURL(options) {
      feedCalls.push(options);
    },
    on(event, fn) {
      handlers.set(event, fn);
      return updater;
    },
    emit(event, ...args) {
      handlers.get(event)?.(...args);
    },
    async checkForUpdates() {},
    async downloadUpdate() {},
    quitAndInstall(isSilent, isForceRunAfter) {
      quitAndInstallArgs = { isSilent, isForceRunAfter };
    },
    ...overrides,
  };

  return {
    updater,
    handlers,
    feedCalls,
    getQuitAndInstallArgs: () => quitAndInstallArgs,
  };
}

test('resolveUpdateFeedConfig resolves generic object-storage feeds for stable and test channels', () => {
  assert.equal(normalizeUpdateChannel(undefined), 'stable');
  assert.equal(normalizeUpdateChannel('stable'), 'stable');
  assert.equal(normalizeUpdateChannel('test'), 'test');
  assert.equal(normalizeUpdateChannel('dev'), 'test');

  const stableFeed = resolveUpdateFeedConfig({ channel: 'stable' });
  assert.deepEqual(stableFeed, {
    provider: 'generic',
    url: `${DEFAULT_UPDATE_BASE_URL}/stable`,
    channel: 'stable',
  });

  const defaultFeed = resolveUpdateFeedConfig();
  assert.deepEqual(defaultFeed, stableFeed);

  const testFeed = resolveUpdateFeedConfig({ channel: 'test' });
  assert.deepEqual(testFeed, {
    provider: 'generic',
    url: `${DEFAULT_UPDATE_BASE_URL}/test`,
    channel: 'test',
  });

  // In-domain custom overrides are accepted and trailing slashes are normalized.
  const customStable = resolveUpdateFeedConfig({
    channel: 'stable',
    feedUrl: 'https://cdn.open-design.ai/open-motion/desktop/stable///',
  });
  assert.deepEqual(customStable, {
    provider: 'generic',
    url: 'https://cdn.open-design.ai/open-motion/desktop/stable',
    channel: 'stable',
  });

  const customTest = resolveUpdateFeedConfig({
    channel: 'test',
    feedUrl: `${TEST_STUDIO_ORIGIN}/releases/desktop/test/`,
  });
  assert.deepEqual(customTest, {
    provider: 'generic',
    url: `${TEST_STUDIO_ORIGIN}/releases/desktop/test`,
    channel: 'test',
  });
});

test('resolveUpdateFeedConfig and DesktopUpdaterController reject out-of-domain custom feed URLs', () => {
  const rejectedStableUrls = [
    'https://evil.example.com/open-motion/desktop/stable',
    'https://api.github.com/repos/nexu-io/openmotion/releases/latest',
    `${TEST_STUDIO_ORIGIN}/releases/desktop/stable`,
    'https://releases.open-design.ai.evil.com/open-motion/desktop/stable',
    'http://releases.open-design.ai/open-motion/desktop/stable',
    'https://user:pass@releases.open-design.ai/open-motion/desktop/stable',
    'file:///tmp/updates',
    'https://releases.open-design.ai/open-motion\n/injected',
  ];

  for (const badUrl of rejectedStableUrls) {
    assert.throws(
      () => resolveUpdateFeedConfig({ channel: 'stable', feedUrl: badUrl }),
      /outside allowed domain scope|control characters/i,
      `Expected stable feed rejection for ${badUrl}`,
    );
    assert.throws(
      () =>
        new DesktopUpdaterController({
          currentVersion: '0.2.1',
          isPackaged: true,
          channel: 'stable',
          feedUrl: badUrl,
        }),
      /outside allowed domain scope|control characters/i,
      `Expected controller constructor rejection for ${badUrl}`,
    );
  }

  // Test channel still rejects untrusted external domains and plain HTTP.
  for (const badTestUrl of [
    'https://evil.example.com/desktop/test',
    'https://github.com/nexu-io/openmotion/releases',
    `http://${TEST_STUDIO_HOST}/desktop/test`,
  ]) {
    assert.throws(
      () => resolveUpdateFeedConfig({ channel: 'test', feedUrl: badTestUrl }),
      /outside allowed domain scope/i,
      `Expected test feed rejection for ${badTestUrl}`,
    );
  }
});

test('GitHub Releases fallback is completely removed and missing/unreachable generic feed returns explicit error', async () => {
  const updaterSource = readFileSync(path.join(desktopRoot, 'src', 'updater.ts'), 'utf8');
  assert.equal(updaterSource.includes('GITHUB_LATEST_RELEASE_API'), false);
  assert.equal(updaterSource.includes('checkViaGitHubApi'), false);
  assert.equal(updaterSource.includes('usingGitHubFallback'), false);
  assert.equal(updaterSource.includes('api.github.com'), false);

  // Verify global fetch is never invoked when the generic feed returns 404 or is unreachable.
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('Unexpected fetch call');
  };

  try {
    const missingFeedMock = createFakeAutoUpdater({
      async checkForUpdates() {
        throw new Error('HttpError: 404 "Cannot find channel stable-mac.yml update info"');
      },
    });
    const controller404 = new DesktopUpdaterController({
      currentVersion: '0.2.1',
      isPackaged: true,
      channel: 'stable',
      loadAutoUpdater: async () => missingFeedMock.updater,
    });

    const missingState = await controller404.checkForUpdates();
    assert.equal(missingState.status, 'error');
    assert.match(missingState.message ?? '', /Update feed manifest not found/i);
    assert.match(missingState.message ?? '', /releases\.open-design\.ai\/open-motion\/desktop\/stable/);
    assert.equal(fetchCalled, false, 'Updater must never fall back to GitHub HTTP fetch');

    const unreachableMock = createFakeAutoUpdater({
      async checkForUpdates() {
        throw new Error('net::ERR_NAME_NOT_RESOLVED');
      },
    });
    const controllerNet = new DesktopUpdaterController({
      currentVersion: '0.2.1',
      isPackaged: true,
      channel: 'test',
      loadAutoUpdater: async () => unreachableMock.updater,
    });

    const netState = await controllerNet.checkForUpdates();
    assert.equal(netState.status, 'error');
    assert.match(netState.message ?? '', /Update feed unreachable/i);
    assert.match(netState.message ?? '', /releases\.open-design\.ai\/open-motion\/desktop\/test/);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DesktopUpdaterController configures generic feed with silent background auto-download and installUpdateNow', async () => {
  const unpackaged = new DesktopUpdaterController({ currentVersion: '0.2.1', isPackaged: false });
  assert.equal(unpackaged.getState().status, 'unsupported');
  assert.equal((await unpackaged.checkForUpdates()).status, 'unsupported');
  assert.equal((await unpackaged.downloadUpdate()).status, 'unsupported');
  assert.equal((await unpackaged.installUpdateNow()).ok, false);

  let beforeQuitCalled = false;
  let downloadInvoked = 0;

  const mock = createFakeAutoUpdater({
    async checkForUpdates() {
      mock.updater.emit('checking-for-update');
      mock.updater.emit('update-available', {
        version: '0.3.0',
        releaseNotesUrl: 'https://releases.open-design.ai/open-motion/desktop/stable/notes-0.3.0.html',
      });
      // Simulate electron-updater automatic background download when autoDownload === true.
      if (mock.updater.autoDownload) {
        mock.updater.emit('download-progress', { percent: 42.6 });
        mock.updater.emit('update-downloaded', { version: '0.3.0' });
      }
    },
    async downloadUpdate() {
      downloadInvoked += 1;
    },
    quitAndInstall(isSilent, isForceRunAfter) {
      assert.equal(beforeQuitCalled, true, 'beforeQuit hook must complete before quitAndInstall');
      mock.updater.lastQuitCall = { isSilent, isForceRunAfter };
    },
  });

  const controller = new DesktopUpdaterController({
    currentVersion: '0.2.1',
    isPackaged: true,
    channel: 'stable',
    loadAutoUpdater: async () => mock.updater,
  });

  const observedStatuses = [];
  const unsubscribe = controller.subscribe(state => {
    observedStatuses.push({
      status: state.status,
      availableVersion: state.availableVersion,
      progress: state.progress,
    });
  });

  const finalState = await controller.checkForUpdates();
  unsubscribe();

  assert.equal(mock.updater.autoDownload, true);
  assert.equal(mock.updater.autoInstallOnAppQuit, true);
  assert.deepEqual(mock.feedCalls, [
    {
      provider: 'generic',
      url: 'https://releases.open-design.ai/open-motion/desktop/stable',
      channel: 'stable',
    },
  ]);

  assert.deepEqual(
    observedStatuses.map(entry => entry.status),
    ['checking', 'checking', 'available', 'downloading', 'downloaded'],
  );
  assert.equal(observedStatuses[3].progress, 43);
  assert.equal(finalState.status, 'downloaded');
  assert.equal(finalState.availableVersion, '0.3.0');
  assert.equal(finalState.progress, 100);
  assert.equal(
    finalState.releaseNotesUrl,
    'https://releases.open-design.ai/open-motion/desktop/stable/notes-0.3.0.html',
  );

  // Calling downloadUpdate() after background download already completed is idempotent.
  const redownload = await controller.downloadUpdate();
  assert.equal(redownload.status, 'downloaded');
  assert.equal(downloadInvoked, 0);

  const installResult = await controller.installUpdateNow(async () => {
    beforeQuitCalled = true;
  });
  assert.deepEqual(installResult, { ok: true });
  assert.deepEqual(mock.updater.lastQuitCall, { isSilent: false, isForceRunAfter: true });
});

test('DesktopUpdaterController supports manual downloadUpdate and CJS/ESM autoUpdater resolution', async () => {
  const mock = createFakeAutoUpdater({
    async checkForUpdates() {
      mock.updater.emit('checking-for-update');
      mock.updater.emit('update-available', {
        version: '0.3.1',
        // Untrusted releaseNotesUrl must be stripped.
        releaseNotesUrl: 'https://evil.example.com/notes',
      });
    },
    async downloadUpdate() {
      mock.updater.emit('download-progress', { percent: 80 });
      mock.updater.emit('update-downloaded', { version: '0.3.1' });
    },
  });

  assert.equal(resolveElectronAutoUpdater({ default: { autoUpdater: mock.updater } }), mock.updater);
  assert.equal(resolveElectronAutoUpdater({ autoUpdater: mock.updater }), mock.updater);
  assert.throws(() => resolveElectronAutoUpdater({ autoUpdater: { checkForUpdates() {} } }), /unavailable/i);

  assert.equal(normalizeSemver('v0.3.1'), '0.3.1');
  assert.ok(compareSemver('0.3.1', '0.3.0') > 0);
  assert.equal(compareSemver('v0.3.1', '0.3.1'), 0);

  const controller = new DesktopUpdaterController({
    currentVersion: '0.3.0',
    isPackaged: true,
    channel: 'test',
    autoDownload: false,
    loadAutoUpdater: async () => mock.updater,
  });

  const avail = await controller.checkForUpdates();
  assert.equal(avail.status, 'available');
  assert.equal(avail.availableVersion, '0.3.1');
  assert.equal(avail.releaseNotesUrl, undefined);

  const downloaded = await controller.downloadUpdate();
  assert.equal(downloaded.status, 'downloaded');
  assert.equal(downloaded.progress, 100);
});

test('desktop/electron-builder.yml defines thin-shell packaging, openmotion protocol, generic publish, and no Linux/app-server', () => {
  const builderYml = readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');

  assert.match(builderYml, /^appId:\s*io\.nexu\.openmotion\.desktop$/m);
  assert.match(builderYml, /^productName:\s*OpenDesign$/m);

  // Thin shell: no bundled app-server; mac extraResources is strictly limited to compiled Assets.car icon catalog.
  assert.equal(builderYml.includes('app-server'), false);
  assert.match(builderYml, /CFBundleIconName:\s*AppIcon/);
  assert.match(builderYml, /-\s*Assets\.car\b/);
  assert.match(builderYml, /afterPack:\s*scripts\/after-pack\.cjs/);

  // Protocol registration for openmotion://.
  assert.match(builderYml, /^protocols:\s*$/m);
  assert.match(builderYml, /name:\s*OpenDesign/);
  assert.match(builderYml, /-\s*openmotion\b/);

  // macOS notarization and dmg/zip targets (arch selected per CLI job: --arm64 or --x64).
  assert.match(builderYml, /^mac:\s*$/m);
  assert.match(builderYml, /^\s+notarize:\s*true$/m);
  assert.match(builderYml, /target:\s*dmg/);
  assert.match(builderYml, /target:\s*zip/);
  const macBlockMatch = builderYml.match(/^mac:\n([\s\S]*?)^\S/m);
  assert.ok(macBlockMatch, 'Expected mac section in electron-builder.yml');
  assert.equal(
    macBlockMatch[1].includes('arch:'),
    false,
    'mac target must inherit single --arm64 / --x64 CLI arch flag instead of forcing multi-arch on one runner',
  );

  // Windows nsis + portable x64 targets only.
  assert.match(builderYml, /^win:\s*$/m);
  assert.match(builderYml, /target:\s*nsis/);
  assert.match(builderYml, /target:\s*portable/);
  const winBlockMatch = builderYml.match(/^win:\n([\s\S]*?)^\S/m);
  assert.ok(winBlockMatch, 'Expected win section in electron-builder.yml');
  assert.equal(winBlockMatch[1].includes('arm64'), false, 'Windows first package targets x64 only');

  // No Linux packaging target.
  assert.equal(/^linux:/m.test(builderYml), false);
  assert.equal(builderYml.includes('AppImage'), false);

  // Generic object-storage publish configuration (no GitHub provider).
  assert.match(builderYml, /^publish:\s*$/m);
  assert.match(builderYml, /provider:\s*generic/);
  assert.match(
    builderYml,
    /url:\s*https:\/\/releases\.open-design\.ai\/open-motion\/desktop\/stable/,
  );
  assert.equal(builderYml.includes('provider: github'), false);
});

test('desktop/package.json pins Electron 45.4.1 with per-arch thin-shell scripts and build.mjs copies retry.html', () => {
  const pkg = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));

  assert.equal(pkg.devDependencies.electron, '45.4.1');
  assert.equal(typeof pkg.scripts['pack:mac:arm64'], 'string');
  assert.equal(typeof pkg.scripts['pack:mac:x64'], 'string');
  assert.equal(typeof pkg.scripts['pack:win:x64'], 'string');
  assert.equal(typeof pkg.scripts['pack:dir'], 'string');
  assert.equal(typeof pkg.scripts['pack:mac:local'], 'string');
  assert.equal(pkg.scripts['pack:linux'], undefined);

  for (const key of ['pack:mac:arm64', 'pack:mac:x64', 'pack:win:x64', 'pack:dir', 'pack:mac:local']) {
    assert.equal(
      pkg.scripts[key].includes('stage'),
      false,
      `${key} must not run stage-app.mjs in thin-shell packaging`,
    );
  }

  const buildScript = readFileSync(path.join(desktopRoot, 'scripts', 'build.mjs'), 'utf8');
  assert.match(buildScript, /splash\.html/);
  assert.match(buildScript, /retry\.html/);
});

test('.github/workflows/desktop-release.yml enforces main-only per-arch builds with direct release-bucket upload', () => {
  const workflowYml = readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'desktop-release.yml'),
    'utf8',
  );

  // Manual workflow_dispatch plus automatic push trigger on desktop-test branch for desktop & coupled shared paths.
  assert.match(workflowYml, /push:\s*\n\s+branches:\s*\n\s+-\s*desktop-test\b/);
  assert.match(workflowYml, /'desktop\/\*\*'/);
  assert.match(workflowYml, /'shared\/desktop-\*\.ts'/);
  assert.match(workflowYml, /'shared\/platform-host\.ts'/);
  assert.match(workflowYml, /'shared\/signed-config\.ts'/);
  assert.match(workflowYml, /'shared\/engine-command-contract\.ts'/);
  assert.match(workflowYml, /'packages\/local-atoms\/\*\*'/);
  assert.match(workflowYml, /'packages\/signed-config\/\*\*'/);
  assert.match(workflowYml, /'packages\/observability\/\*\*'/);

  // Both packaging steps receive the build-time trust anchors and the Sentry DSN.
  for (const name of [
    'OPENMOTION_DESKTOP_ROOT_PUBLIC_KEY_SPKI',
    'OPENMOTION_MURMUR_APPLE_TEAM_ID',
    'OPENMOTION_MURMUR_WIN_THUMBPRINTS',
    'SENTRY_DESKTOP_DSN',
    'OPENMOTION_DESKTOP_REQUIRE_SENTRY_DSN',
  ]) {
    assert.equal(workflowYml.split(`          ${name}:`).length - 1, 2, `${name} must be set on both packaging steps`);
  }
  assert.match(workflowYml, /SENTRY_DESKTOP_DSN: \$\{\{ secrets\.SENTRY_DESKTOP_DSN \}\}/);
  assert.match(workflowYml, /sourcemaps upload/);
  assert.match(workflowYml, /--url-prefix "app:\/\/\/dist"/);
  const builderYml = readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
  assert.match(builderYml, /"!dist\/\*\*\/\*\.map"/);
  assert.match(workflowYml, /'packages\/design-system\/brand\/\*\*'/);
  assert.match(workflowYml, /'\.github\/workflows\/desktop-release\.yml'/);
  assert.match(workflowYml, /workflow_dispatch:/);
  assert.match(workflowYml, /default:\s*test/);
  assert.match(workflowYml, /-\s*test\b/);
  assert.match(workflowYml, /-\s*stable\b/);
  assert.match(workflowYml, /default:\s*false/);

  // Branch & channel release guards + Scheme A release version resolution.
  assert.match(workflowYml, /refs\/heads\/main/);
  assert.match(workflowYml, /refs\/heads\/desktop-test/);
  assert.match(workflowYml, /resolve-release-version\.mjs/);
  assert.match(workflowYml, /-c\.extraMetadata\.version=/);
  assert.match(workflowYml, /-c\.buildNumber=/);
  assert.match(workflowYml, /-c\.buildVersion=/);

  // Per-architecture matrix definitions: macOS arm64, optional macOS x64, Windows x64.
  assert.match(workflowYml, /label:\s*"?macOS arm64"?/);
  assert.match(workflowYml, /label:\s*"?macOS x64"?/);
  assert.match(workflowYml, /label:\s*"?Windows x64"?/);
  assert.match(workflowYml, /os:\s*"?macos-26"?/);
  assert.match(workflowYml, /Assets\.car/);
  assert.match(workflowYml, /os:\s*"?windows-latest"?/);
  assert.match(workflowYml, /pack_script:\s*"?pack:mac:arm64"?/);
  assert.match(workflowYml, /pack_script:\s*"?pack:mac:x64"?/);
  assert.match(workflowYml, /pack_script:\s*"?pack:win:x64"?/);

  // Apple Developer ID signing & fast notarization hook wiring (org-level secrets with fallback).
  assert.match(workflowYml, /CSC_LINK:.*APPLE_SIGNING_CERTIFICATE_BASE64/);
  assert.match(workflowYml, /CSC_KEY_PASSWORD:.*APPLE_SIGNING_CERTIFICATE_PASSWORD/);
  assert.match(workflowYml, /APPLE_ID:/);
  assert.match(workflowYml, /APPLE_APP_SPECIFIC_PASSWORD:/);
  assert.match(workflowYml, /APPLE_TEAM_ID:/);
  assert.match(workflowYml, /APPLE_API_KEY:/);
  assert.match(workflowYml, /-c\.afterSign=scripts\/notarize\.cjs/);

  // Parallel DAG (prepare -> verify-desktop || build-desktop -> publish-manifests), sparse checkout, and binary caching.
  assert.match(workflowYml, /^  prepare:/m);
  assert.match(workflowYml, /^  verify-desktop:/m);
  assert.match(workflowYml, /^  publish-manifests:/m);
  assert.match(workflowYml, /needs:\s*\[prepare,\s*verify-desktop,\s*build-desktop\]/);
  assert.match(workflowYml, /sparse-checkout:/);
  assert.match(workflowYml, /ELECTRON_SKIP_BINARY_DOWNLOAD:\s*'1'/);
  assert.match(workflowYml, /uses:\s*actions\/cache@v4/);
  assert.match(workflowYml, /desktop\/package-lock\.json/);
  assert.match(workflowYml, /-c\.win\.target=nsis/);
  assert.match(workflowYml, /\$\{EXTRA_BUILDER_ARGS\[@\]\+"\$\{EXTRA_BUILDER_ARGS\[@\]\}"\}/);
  assert.match(workflowYml, /max_concurrent_requests/);

  // No GitHub Actions artifact upload or GitHub Release binary upload.
  assert.equal(workflowYml.includes('upload-artifact'), false);
  assert.equal(workflowYml.includes('gh release upload'), false);

  // Direct Cloudflare R2 / S3 upload targeting releases.open-design.ai / open-motion/desktop/<channel>/.
  assert.match(workflowYml, /CLOUDFLARE_R2_RELEASES_BUCKET/);
  assert.match(workflowYml, /CLOUDFLARE_R2_RELEASES_URL/);
  assert.match(workflowYml, /CLOUDFLARE_R2_RELEASES_AK/);
  assert.match(workflowYml, /CLOUDFLARE_R2_RELEASES_SK/);
  assert.match(workflowYml, /AWS_DEFAULT_REGION:\s*auto/);
  assert.match(workflowYml, /AWS_REQUEST_CHECKSUM_CALCULATION:\s*when_required/);
  assert.match(workflowYml, /releases\.open-design\.ai/);
  assert.match(workflowYml, /open-motion\/desktop\//);
  assert.match(workflowYml, /aws\s+.*s3 cp/);
  assert.match(workflowYml, /extraMetadata\.openmotionChannel=/);
  assert.match(workflowYml, /npm --prefix desktop ci/);
  assert.match(workflowYml, /npm --prefix desktop test/);
  assert.match(workflowYml, /FEISHU_DESKTOP_NOTIFY_WEBHOOK/);
  assert.match(workflowYml, /FEISHU_DESKTOP_NOTIFY_ENABLED/);
  assert.match(workflowYml, /latest-meta\.json/);
  assert.match(workflowYml, /notify-feishu-release\.mjs/);
});

test('desktop/scripts/notarize.cjs skips non-darwin or OM_SKIP_NOTARIZE and resolves Apple credentials', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const notarizeHook = req(path.join(desktopRoot, 'scripts', 'notarize.cjs'));

  const nonDarwin = await notarizeHook({ electronPlatformName: 'win32' });
  assert.deepEqual(nonDarwin, { skipped: true, reason: 'non-darwin' });

  const prevSkip = process.env.OM_SKIP_NOTARIZE;
  process.env.OM_SKIP_NOTARIZE = '1';
  try {
    const skipped = await notarizeHook({ electronPlatformName: 'darwin' });
    assert.deepEqual(skipped, { skipped: true, reason: 'skip-env' });
  } finally {
    if (prevSkip === undefined) {
      delete process.env.OM_SKIP_NOTARIZE;
    } else {
      process.env.OM_SKIP_NOTARIZE = prevSkip;
    }
  }

  assert.equal(
    notarizeHook.resolveNotaryCredentials({
      APPLE_ID: 'dev@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'secret',
      APPLE_TEAM_ID: 'TEAM123',
    })?.mode,
    'apple-id',
  );
  assert.equal(
    notarizeHook.resolveNotaryCredentials({
      APPLE_API_KEY: '/tmp/key.p8',
      APPLE_API_KEY_ID: 'KEY123',
      APPLE_API_ISSUER: 'ISSUER123',
    })?.mode,
    'api-key',
  );
  assert.equal(notarizeHook.resolveNotaryCredentials({}), null);
});

test('desktop/scripts/sign-mac.cjs detects Mach-O binaries, layers bottom-up, and caps concurrency at 6', async () => {
  const { createRequire } = await import('node:module');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const req = createRequire(import.meta.url);
  const signMac = req(path.join(desktopRoot, 'scripts', 'sign-mac.cjs'));

  const builderYml = readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
  assert.match(builderYml, /^\s+sign:\s*scripts\/sign-mac\.cjs$/m);
  assert.equal(signMac.resolveConcurrency({}), 6);
  assert.equal(signMac.resolveConcurrency({ OM_CODESIGN_CONCURRENCY: '4' }), 4);

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'om-sign-mac-test-'));
  try {
    const macho64 = path.join(tmpDir, 'bin64');
    writeFileSync(macho64, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]));
    const fatMacho = path.join(tmpDir, 'fat');
    writeFileSync(fatMacho, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]));
    const javaClass = path.join(tmpDir, 'Fake.class');
    writeFileSync(javaClass, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x37]));
    const pakFile = path.join(tmpDir, 'locale.pak');
    writeFileSync(pakFile, Buffer.from([0x05, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]));

    assert.equal(signMac.isMachOFile(macho64), true);
    assert.equal(signMac.isMachOFile(fatMacho), true);
    assert.equal(signMac.isMachOFile(javaClass), false);
    assert.equal(signMac.isMachOFile(pakFile), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const waves = signMac.groupSigningLayers([
    '/App.app/Contents/Frameworks/Electron Framework.framework',
    '/App.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib',
    '/App.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler',
    '/App.app/Contents/Frameworks/Squirrel.framework',
    '/App.app/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt',
    '/App.app/Contents/Frameworks/Helper.app',
  ]);
  assert.equal(waves.length, 2);
  assert.deepEqual(waves[0], [
    '/App.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler',
    '/App.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib',
    '/App.app/Contents/Frameworks/Helper.app',
    '/App.app/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt',
  ]);
  assert.deepEqual(waves[1], [
    '/App.app/Contents/Frameworks/Electron Framework.framework',
    '/App.app/Contents/Frameworks/Squirrel.framework',
  ]);

  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 18 }, (_, i) => i);
  const out = await signMac.runWithConcurrency(items, 6, async (item) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return item * 2;
  });
  assert.equal(peak <= 6 && peak >= 2, true, `expected bounded concurrency <=6, got peak=${peak}`);
  assert.deepEqual(out, items.map((i) => i * 2));

  const args = signMac.buildCodesignArgs(
    '/App.app',
    { identity: 'ABC123', keychain: '/tmp/build.keychain' },
    { hardenedRuntime: true, entitlements: '/tmp/entitlements.mac.plist' },
  );
  assert.deepEqual(args, [
    '--sign',
    'ABC123',
    '--force',
    '--keychain',
    '/tmp/build.keychain',
    '--timestamp',
    '--options',
    'runtime',
    '--entitlements',
    '/tmp/entitlements.mac.plist',
    '/App.app',
  ]);
});

test('resolvePackagedReleaseChannel preserves test channel from bundle metadata even for clean semver versions', () => {
  assert.equal(
    resolvePackagedReleaseChannel({
      isPackaged: true,
      version: '0.2.1',
      packageChannel: 'test',
    }),
    'test',
  );
  assert.equal(
    resolvePackagedReleaseChannel({
      isPackaged: true,
      version: '0.2.1',
      appUpdateYmlContent: 'provider: generic\nurl: https://releases.open-design.ai/open-motion/desktop/test\nchannel: test\n',
    }),
    'test',
  );
  assert.equal(
    resolvePackagedReleaseChannel({
      isPackaged: true,
      version: '0.2.1',
      envChannel: 'dev',
      packageChannel: 'stable',
    }),
    'stable',
    'packaged builds must not allow MOTION_DESKTOP_CHANNEL=dev override',
  );
  assert.equal(
    resolvePackagedReleaseChannel({
      isPackaged: false,
      version: '0.2.1',
    }),
    'dev',
  );
});

test('resolveDesktopReleaseVersion implements Scheme A monotonic SemVer and Windows PE buildVersion', () => {
  const test1 = resolveDesktopReleaseVersion({ baseVersion: '0.2.1', channel: 'test', runNumber: 1 });
  const test1Retry = resolveDesktopReleaseVersion({ baseVersion: '0.2.1', channel: 'test', runNumber: 1, runAttempt: 2 });
  const test2 = resolveDesktopReleaseVersion({ baseVersion: '0.2.1', channel: 'test', runNumber: 2 });
  const test10 = resolveDesktopReleaseVersion({ baseVersion: '0.2.1', channel: 'test', runNumber: 10 });
  const stableNext = resolveDesktopReleaseVersion({ baseVersion: '0.2.2', channel: 'stable', runNumber: 11 });

  assert.equal(test1.version, '0.2.2-test.1');
  assert.equal(test1.buildNumber, '1');
  assert.equal(test1.buildVersion, '0.2.2.1');
  assert.equal(test1Retry.version, '0.2.2-test.1.2');
  assert.equal(test1Retry.buildVersion, '0.2.2.1');
  assert.equal(test10.version, '0.2.2-test.10');
  assert.equal(stableNext.version, '0.2.2');
  assert.equal(stableNext.buildVersion, '0.2.2.11');

  assert.ok(compareSemver('0.2.1', test1.version) < 0);
  assert.ok(compareSemver(test1.version, test1Retry.version) < 0);
  assert.ok(compareSemver(test1Retry.version, test2.version) < 0);
  assert.ok(compareSemver(test2.version, test10.version) < 0);
  assert.ok(compareSemver(test10.version, stableNext.version) < 0);

  assert.throws(() => resolveDesktopReleaseVersion({ baseVersion: '0.2.1-test.1', channel: 'test', runNumber: 1 }));
  assert.throws(() => resolveDesktopReleaseVersion({ baseVersion: '0.2.1', channel: 'beta', runNumber: 1 }));
  assert.throws(() => resolveDesktopReleaseVersion({ baseVersion: '0.2.1', channel: 'test', runNumber: 70000 }));
});

test('DesktopUpdaterController enables allowPrerelease on test channel and disables it on stable', async () => {
  const testFake = createFakeAutoUpdater();
  const testController = new DesktopUpdaterController({
    currentVersion: '0.2.1',
    isPackaged: true,
    channel: 'test',
    loadAutoUpdater: async () => testFake.updater,
  });
  await testController.checkForUpdates();
  assert.equal(testFake.updater.allowPrerelease, true);
  assert.equal(testFake.updater.channel, 'test');

  const stableFake = createFakeAutoUpdater();
  const stableController = new DesktopUpdaterController({
    currentVersion: '0.2.1',
    isPackaged: true,
    channel: 'stable',
    loadAutoUpdater: async () => stableFake.updater,
  });
  await stableController.checkForUpdates();
  assert.equal(stableFake.updater.allowPrerelease, false);
  assert.equal(stableFake.updater.channel, 'stable');
});

test('notify-feishu-release builds signed Card 2.0 payload, respects includeMacX64, and validates hosts', async () => {
  assert.throws(() => validateFeishuWebhookUrl('https://evil.example.com/open-apis/bot/v2/hook/abc'));
  assert.throws(() => validateFeishuWebhookUrl(HTTP_FEISHU_WEBHOOK_URL));
  assert.equal(
    validateFeishuWebhookUrl(TEST_FEISHU_WEBHOOK_URL),
    TEST_FEISHU_WEBHOOK_URL,
  );

  const fullPayload = buildDesktopReleaseCardPayload({
    channel: 'test',
    version: '0.2.2-test.2',
    buildVersion: '0.2.2.2',
    branch: 'desktop-test',
    commitSha: '5cdd6dec555422fc',
    commitSubject: 'fix(desktop-ci): guard bash 3.2 empty arrays',
    actor: 'heggria',
    runUrl: 'https://github.com/nexu-io/openmotion/actions/runs/45325228402',
    includeMacX64: true,
    secret: 'test-secret',
    timestampSeconds: 1700000000,
  });
  assert.equal(fullPayload.msg_type, 'interactive');
  assert.equal(fullPayload.card.schema, '2.0');
  assert.equal(fullPayload.card.header.template, 'blue');
  assert.equal(fullPayload.card.header.text_tag_list[0].text.content, 'TEST');
  assert.equal(fullPayload.sign, signFeishuWebhook('test-secret', '1700000000'));
  const fullText = JSON.stringify(fullPayload.card);
  assert.equal(fullText.includes('`'), false);
  assert.match(fullText, /OpenDesign-0\.2\.2-test\.2-mac-arm64\.dmg/);
  assert.match(fullText, /OpenDesign-0\.2\.2-test\.2-mac-x64\.dmg/);
  assert.match(fullText, /OpenDesign-Setup-0\.2\.2-test\.2-win-x64\.exe/);
  assert.equal(fullText.includes('OpenDesign-Portable-0.2.2-test.2-win-x64.exe'), false);

  // Stable builds include the Windows portable button by default.
  const stableCardText = JSON.stringify(
    buildDesktopReleaseCardPayload({
      channel: 'stable',
      version: '0.2.2',
    }).card,
  );
  assert.match(stableCardText, /OpenDesign-Portable-0\.2\.2-win-x64\.exe/);
  assert.match(fullText, /内网极速下载（Mirror）/);
  assert.match(
    fullText,
    /https:\/\/mirror\.inner\.nexu\.space\/f\/od-next\/test\/0\.2\.2-test\.2\/OpenDesign-0\.2\.2-test\.2-mac-arm64\.dmg/,
  );
  assert.match(
    fullText,
    /https:\/\/mirror\.inner\.nexu\.space\/f\/od-next\/test\/0\.2\.2-test\.2\/OpenDesign-Setup-0\.2\.2-test\.2-win-x64\.exe/,
  );
  assert.match(fullText, /https:\/\/ops\.inner\.nexu\.space\/mirror\/search\?q=od-next%20test/);

  const armOnlyPayload = buildDesktopReleaseCardPayload({
    channel: 'test',
    version: '0.2.2-test.3',
    includeMacX64: false,
  });
  const armOnlyText = JSON.stringify(armOnlyPayload.card);
  assert.match(armOnlyText, /OpenDesign-0\.2\.2-test\.3-mac-arm64\.dmg/);
  assert.equal(armOnlyText.includes('mac-x64.dmg'), false);
  assert.match(
    armOnlyText,
    /mirror\.inner\.nexu\.space\/f\/od-next\/test\/0\.2\.2-test\.3\/OpenDesign-0\.2\.2-test\.3-mac-arm64\.dmg/,
  );

  const noMirrorText = JSON.stringify(
    buildDesktopReleaseCardPayload({
      channel: 'test',
      version: '0.2.2-test.3',
      mirrorOrigin: 'none',
      mirrorConsoleUrl: '',
    }).card,
  );
  assert.equal(noMirrorText.includes('内网极速下载'), false);
  assert.throws(() =>
    buildDesktopReleaseCardPayload({
      channel: 'test',
      version: '0.2.2-test.3',
      mirrorOrigin: 'http://mirror.inner.nexu.space',
    }),
  );

  const result = await sendFeishuReleaseNotification({
    webhookUrl: TEST_FEISHU_WEBHOOK_URL,
    channel: 'test',
    version: '0.2.2-test.2',
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 }),
  });
  assert.equal(result.ok, true);
});

test('formatStructuredReleaseChangelog groups conventional commits and honors manual release notes', () => {
  const grouped = formatStructuredReleaseChangelog({
    commits: [
      'Merge branch main into desktop-test',
      'fix(desktop-auth): repair IPC sign-in serialization',
      'feat(desktop): structured changelog block',
      'perf(desktop): parallel macOS signing',
      'test(desktop): noise test',
    ],
  });
  assert.equal(grouped.source, 'commits');
  assert.match(grouped.markdown, /\*\*新增\*\*/);
  assert.match(grouped.markdown, /\*\*修复\*\*/);
  assert.match(grouped.markdown, /\*\*优化\*\*/);
  assert.equal(grouped.markdown.includes('Merge branch'), false);
  assert.equal(grouped.markdown.includes('noise test'), false);

  const manual = formatStructuredReleaseChangelog({
    commits: ['fix(desktop): internal'],
    manualNotes: '- 修复客户端登录\n- 优化启动体验',
  });
  assert.equal(manual.source, 'manual');
  assert.match(manual.markdown, /修复客户端登录/);
});

test('resolveBuildTrustAnchors embeds a validated Sentry DSN and can require one', () => {
  const empty = resolveBuildTrustAnchors({});
  assert.equal(empty.sentryDsn, '');
  assert.equal(JSON.parse(empty.define.__OPENMOTION_DESKTOP_SENTRY_DSN__), '');

  const dsn = 'https://publickey123@o1.ingest.example.com/42';
  const resolved = resolveBuildTrustAnchors({ SENTRY_DESKTOP_DSN: ` ${dsn} ` });
  assert.equal(resolved.sentryDsn, dsn);
  assert.equal(JSON.parse(resolved.define.__OPENMOTION_DESKTOP_SENTRY_DSN__), dsn);

  for (const bad of [
    'not-a-dsn',
    'http://key@example.com/42',
    'https://example.com/42',
    'https://key@example.com/project',
    'https://key@example.com/42?x=1',
  ]) {
    assert.throws(
      () => resolveBuildTrustAnchors({ SENTRY_DESKTOP_DSN: bad }),
      error => {
        assert.match(error.message, /Invalid SENTRY_DESKTOP_DSN/);
        assert.ok(!error.message.includes(bad));
        return true;
      },
    );
  }

  assert.throws(
    () => resolveBuildTrustAnchors({ OPENMOTION_DESKTOP_REQUIRE_SENTRY_DSN: '1' }),
    /SENTRY_DESKTOP_DSN is required/,
  );
  assert.equal(
    resolveBuildTrustAnchors({ OPENMOTION_DESKTOP_REQUIRE_SENTRY_DSN: '1', SENTRY_DESKTOP_DSN: dsn }).sentryDsn,
    dsn,
  );
});

test('injectBundleDebugId embeds deterministic TC39/Sentry Debug IDs into JS and .map files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'om-debug-id-'));
  try {
    const jsPath = path.join(dir, 'main.mjs');
    const mapPath = `${jsPath}.map`;
    writeFileSync(jsPath, 'console.log("hello");\n', 'utf8');
    writeFileSync(mapPath, JSON.stringify({ version: 3, sources: ['src/main.ts'], mappings: '' }), 'utf8');
    const debugId = injectBundleDebugId(jsPath, mapPath);
    assert.match(debugId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const jsAfter = readFileSync(jsPath, 'utf8');
    const mapAfter = JSON.parse(readFileSync(mapPath, 'utf8'));
    assert.equal(mapAfter.debugId, debugId);
    assert.ok(jsAfter.includes(`//# debugId=${debugId}`));
    assert.ok(jsAfter.includes('_sentryDebugIds'));
    assert.equal(jsAfter.includes('sourceMappingURL='), false);
    // Idempotent on re-run
    assert.equal(injectBundleDebugId(jsPath, mapPath), debugId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBuildTrustAnchors validates and normalizes Ed25519 root key, Apple Team ID, and Windows thumbprints', () => {
  const empty = resolveBuildTrustAnchors({});
  assert.equal(empty.rootPublicKeySpki, '');
  assert.equal(empty.murmurAppleTeamId, '');
  assert.equal(empty.murmurWinThumbprints, '');

  const pair = generateEd25519KeyPair();
  const sha1 = 'a'.repeat(40);
  const sha256 = 'B'.repeat(64);
  const fromPem = resolveBuildTrustAnchors({
    OPENMOTION_DESKTOP_ROOT_PUBLIC_KEY_SPKI: pair.publicKeyPem,
    OPENMOTION_MURMUR_APPLE_TEAM_ID: 'AB12CD34EF',
    OPENMOTION_MURMUR_WIN_THUMBPRINTS: ` ${sha1}, ${sha256} `,
  });
  assert.equal(fromPem.rootPublicKeySpki, pair.publicKeySpkiBase64);
  assert.equal(fromPem.murmurAppleTeamId, 'AB12CD34EF');
  assert.equal(fromPem.murmurWinThumbprints, `${sha1.toUpperCase()},${sha256}`);
  assert.equal(
    JSON.parse(fromPem.define.__OPENMOTION_EMBEDDED_ROOT_PUBLIC_KEY_SPKI__),
    pair.publicKeySpkiBase64,
  );

  const fromBase64 = resolveBuildTrustAnchors({
    OPENMOTION_DESKTOP_ROOT_PUBLIC_KEY_SPKI: pair.publicKeySpkiBase64,
  });
  assert.equal(fromBase64.rootPublicKeySpki, pair.publicKeySpkiBase64);

  assert.throws(
    () => resolveBuildTrustAnchors({ OPENMOTION_DESKTOP_ROOT_PUBLIC_KEY_SPKI: 'not-a-key' }),
    /Invalid OPENMOTION_DESKTOP_ROOT_PUBLIC_KEY_SPKI/,
  );
  assert.throws(
    () => resolveBuildTrustAnchors({ OPENMOTION_MURMUR_APPLE_TEAM_ID: 'invalid-id' }),
    /Invalid OPENMOTION_MURMUR_APPLE_TEAM_ID/,
  );
  assert.throws(
    () => resolveBuildTrustAnchors({ OPENMOTION_MURMUR_WIN_THUMBPRINTS: '1234' }),
    /Invalid OPENMOTION_MURMUR_WIN_THUMBPRINTS/,
  );
});

test('desktop/config channel payloads pass bounds validation and desktop-signed-config.yml enforces sign-verify-publish', () => {
  for (const channel of ['test', 'stable']) {
    const payloadPath = path.join(desktopRoot, 'config', `${channel}.payload.json`);
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
    assert.deepEqual(
      validateSignedConfigPayloadBounds(payload, { channel }),
      [],
      `${channel}.payload.json must pass shell security bounds`,
    );
  }

  const workflowYml = readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'desktop-signed-config.yml'),
    'utf8',
  );
  assert.match(workflowYml, /desktop\/config\/test\.payload\.json/);
  assert.match(workflowYml, /refs\/heads\/main/);
  assert.match(workflowYml, /refs\/heads\/desktop-test/);
  assert.match(workflowYml, /scripts\/sign-desktop-config\.mjs sign-config/);
  assert.match(workflowYml, /scripts\/sign-desktop-config\.mjs verify-config/);
  assert.match(workflowYml, /open-motion\/desktop\/config\/\$\{CHANNEL\}\.json/);
  assert.match(workflowYml, /no-cache, max-age=0/);
});

test('notify-feishu-release groups a structured changelog and links the previous version', async () => {
  assert.throws(() => validateFeishuWebhookUrl('https://evil.example.com/open-apis/bot/v2/hook/abc'));
  assert.throws(() => validateFeishuWebhookUrl(HTTP_FEISHU_WEBHOOK_URL));
  assert.equal(
    validateFeishuWebhookUrl(TEST_FEISHU_WEBHOOK_URL),
    TEST_FEISHU_WEBHOOK_URL,
  );

  const payload = buildDesktopReleaseCardPayload({
    channel: 'test',
    version: '0.2.2-test.7',
    buildVersion: '0.2.2.7',
    previousVersion: '0.2.2-test.6',
    branch: 'desktop-test',
    commitSha: '9de1322862fab5b4',
    commits: [
      'Merge branch main into desktop-test',
      'fix(desktop-auth): repair IPC sign-in serialization and OIDC fallback',
      'feat(desktop): send Card 2.0 release notifications to Feishu group',
      'perf(desktop): add 6-way parallel macOS codesign script',
      'test(desktop): add extra unit tests',
    ],
    compareUrl: 'https://github.com/nexu-io/openmotion/compare/dee8da6f...9de13228',
    actor: 'heggria',
    runUrl: 'https://github.com/nexu-io/openmotion/actions/runs/45333446561',
    secret: 'test-secret',
    timestampSeconds: 1700000000,
  });

  assert.equal(payload.msg_type, 'interactive');
  assert.equal(payload.card.schema, '2.0');
  assert.equal(payload.card.header.template, 'blue');
  assert.match(payload.card.header.subtitle.content, /0\.2\.2-test\.7/);
  assert.equal(payload.card.header.text_tag_list[0].text.content, 'TEST');
  assert.equal(payload.timestamp, '1700000000');
  assert.equal(payload.sign, signFeishuWebhook('test-secret', '1700000000'));
  const cardText = JSON.stringify(payload.card);
  assert.equal(cardText.includes('`'), false, 'Card markdown must not emit literal backticks');
  assert.match(cardText, /对比 v0\.2\.2-test\.6/);
  assert.match(cardText, /\*\*新增\*\*/);
  assert.match(cardText, /\*\*修复\*\*/);
  assert.match(cardText, /\*\*优化\*\*/);
  assert.equal(cardText.includes('Merge branch'), false);
  assert.equal(cardText.includes('add extra unit tests'), false);
  assert.match(cardText, /compare\/dee8da6f\.\.\.9de13228/);
  assert.match(cardText, /primary_filled/);
  assert.match(cardText, /OpenDesign-0\.2\.2-test\.7-mac-arm64\.dmg/);
  assert.match(cardText, /OpenDesign-0\.2\.2-test\.7-mac-x64\.dmg/);
  assert.match(cardText, /OpenDesign-Setup-0\.2\.2-test\.7-win-x64\.exe/);
  assert.equal(cardText.includes('OpenDesign-Portable-0.2.2-test.7-win-x64.exe'), false);
  assert.match(cardText, /内网极速下载（Mirror）/);
  assert.match(
    cardText,
    /https:\/\/mirror\.inner\.nexu\.space\/f\/od-next\/test\/0\.2\.2-test\.7\/OpenDesign-0\.2\.2-test\.7-mac-arm64\.dmg/,
  );
  assert.match(
    cardText,
    /https:\/\/mirror\.inner\.nexu\.space\/f\/od-next\/test\/0\.2\.2-test\.7\/OpenDesign-Setup-0\.2\.2-test\.7-win-x64\.exe/,
  );
  assert.match(cardText, /https:\/\/ops\.inner\.nexu\.space\/mirror\/search\?q=od-next%20test/);

  // Mirror section can be disabled explicitly and omits macOS Intel when includeMacX64=false.
  const noX64Card = JSON.stringify(
    buildDesktopReleaseCardPayload({
      channel: 'test',
      version: '0.2.2-test.8',
      includeMacX64: false,
    }).card,
  );
  assert.equal(noX64Card.includes('mac-x64.dmg'), false);
  assert.match(noX64Card, /mirror\.inner\.nexu\.space\/f\/od-next\/test\/0\.2\.2-test\.8\/OpenDesign-0\.2\.2-test\.8-mac-arm64\.dmg/);

  const noMirrorCard = JSON.stringify(
    buildDesktopReleaseCardPayload({
      channel: 'test',
      version: '0.2.2-test.8',
      mirrorOrigin: 'none',
      mirrorConsoleUrl: '',
    }).card,
  );
  assert.equal(noMirrorCard.includes('内网极速下载'), false);
  assert.throws(() =>
    buildDesktopReleaseCardPayload({
      channel: 'test',
      version: '0.2.2-test.8',
      mirrorOrigin: 'http://mirror.inner.nexu.space',
    }),
  );

  // Manual release notes override commit grouping cleanly.
  const manual = formatStructuredReleaseChangelog({
    commits: ['fix(desktop): internal refactor'],
    manualNotes: '- 修复客户端登录跳转\n- 优化启动速度',
  });
  assert.equal(manual.source, 'manual');
  assert.match(manual.markdown, /修复客户端登录跳转/);
  assert.equal(manual.markdown.includes('internal refactor'), false);

  let postedUrl = '';
  let postedBody = null;
  const result = await sendFeishuReleaseNotification({
    webhookUrl: TEST_FEISHU_WEBHOOK_URL,
    channel: 'test',
    version: '0.2.2-test.2',
    fetchImpl: async (url, init) => {
      postedUrl = url;
      postedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(postedUrl, TEST_FEISHU_WEBHOOK_URL);
  assert.equal(postedBody.msg_type, 'interactive');

  await assert.rejects(
    () =>
      sendFeishuReleaseNotification({
        webhookUrl: TEST_FEISHU_WEBHOOK_URL,
        channel: 'test',
        version: '0.2.2-test.2',
        fetchImpl: async () => new Response(JSON.stringify({ code: 19021, msg: 'sign match fail' }), { status: 200 }),
      }),
    /sign match fail/,
  );
});

test('sanitizeReleaseNotes strips unsafe HTML, decodes entities, handles arrays, and bounds length', () => {
  const htmlNotes =
    '<h2>Highlights</h2><script>alert(1)</script><ul><li>Faster startup &amp; playback</li><li>Fixed &lt;canvas&gt; glitch</li></ul><p>Thanks!</p>';
  const sanitized = sanitizeReleaseNotes(htmlNotes);
  assert.equal(sanitized?.includes('<script>'), false);
  assert.equal(sanitized?.includes('alert(1)'), false);
  assert.equal(sanitized?.includes('<h2>'), false);
  assert.match(sanitized ?? '', /Highlights/);
  assert.match(sanitized ?? '', /- Faster startup & playback/);
  assert.match(sanitized ?? '', /- Fixed <canvas> glitch/);
  assert.match(sanitized ?? '', /Thanks!/);

  const arrayNotes = sanitizeReleaseNotes([
    { version: '0.3.1', note: '<p>Bug fix A</p>' },
    { version: '0.3.0', note: '<p>Feature B</p>' },
  ]);
  assert.match(arrayNotes ?? '', /v0\.3\.1\nBug fix A/);
  assert.match(arrayNotes ?? '', /v0\.3\.0\nFeature B/);

  const longText = 'x'.repeat(5000);
  const truncated = sanitizeReleaseNotes(longText);
  assert.ok(truncated && truncated.length <= 4000);
  assert.ok(truncated?.endsWith('…'));

  assert.equal(sanitizeReleaseNotes('   '), undefined);
  assert.equal(sanitizeReleaseNotes(null), undefined);
});

test('DesktopUpdaterController propagates releaseNotes and enforces minimum version policy', async () => {
  const fake = createFakeAutoUpdater();
  const controller = new DesktopUpdaterController({
    currentVersion: '0.2.2',
    isPackaged: true,
    channel: 'stable',
    loadAutoUpdater: async () => fake.updater,
  });

  const observed = [];
  controller.subscribe(next => observed.push(next));

  // Policy below or equal to current version is not mandatory.
  const nonMandatory = controller.setMinimumVersionPolicy({
    minRequiredVersion: '0.2.2',
    reason: 'Ignored when version satisfies minimum',
  });
  assert.equal(nonMandatory.mandatory, undefined);
  assert.equal(nonMandatory.minRequiredVersion, '0.2.2');
  assert.equal(nonMandatory.mandatoryReason, undefined);

  // Policy above current version flips mandatory=true and falls back to safe downloadUrl when untrusted.
  const mandatoryState = controller.setMinimumVersionPolicy({
    minRequiredVersion: '0.3.0',
    reason: 'Security fix required for cloud auth.',
    downloadUrl: 'https://evil.example.com/installer.dmg',
  });
  assert.equal(mandatoryState.mandatory, true);
  assert.equal(mandatoryState.minRequiredVersion, '0.3.0');
  assert.equal(mandatoryState.mandatoryReason, 'Security fix required for cloud auth.');
  assert.equal(mandatoryState.downloadUrl, DEFAULT_DESKTOP_DOWNLOAD_URL);

  // Allowed in-domain downloadUrl is preserved.
  const customDownloadState = controller.setMinimumVersionPolicy({
    minRequiredVersion: '0.3.0',
    reason: 'Security fix required for cloud auth.',
    downloadUrl: 'https://releases.open-design.ai/open-motion/desktop/stable',
  });
  assert.equal(
    customDownloadState.downloadUrl,
    'https://releases.open-design.ai/open-motion/desktop/stable',
  );

  // Native menu reflects urgent update requirement when mandatory.
  const menuPresentation = resolveUpdaterMenuPresentation(customDownloadState, 'en');
  assert.equal(menuPresentation.action, 'check');
  assert.equal(menuPresentation.label, 'Update Required (v0.3.0)…');
  const zhMenu = resolveUpdaterMenuPresentation(customDownloadState, 'zh-CN');
  assert.equal(zhMenu.label, '需要更新 (v0.3.0)…');

  // Feed update-available populates sanitized releaseNotes, and update-downloaded preserves them.
  await controller.checkForUpdates();
  fake.updater.emit('update-available', {
    version: '0.3.0',
    releaseNotes: '<ul><li>Auth hardening</li><li>Faster startup</li></ul>',
    releaseNotesUrl: 'https://releases.open-design.ai/open-motion/desktop/stable/notes',
  });
  assert.equal(controller.getState().status, 'available');
  assert.match(controller.getState().releaseNotes ?? '', /- Auth hardening/);
  assert.equal(
    controller.getState().releaseNotesUrl,
    'https://releases.open-design.ai/open-motion/desktop/stable/notes',
  );

  fake.updater.emit('update-downloaded', { version: '0.3.0' });
  assert.equal(controller.getState().status, 'downloaded');
  assert.match(controller.getState().releaseNotes ?? '', /- Auth hardening/);
  assert.equal(controller.getState().mandatory, true);

  // If update-not-available fires later, releaseNotes clear while mandatory policy remains enforced.
  fake.updater.emit('update-not-available');
  assert.equal(controller.getState().status, 'up-to-date');
  assert.equal(controller.getState().releaseNotes, undefined);
  assert.equal(controller.getState().mandatory, true);
  assert.equal(controller.getState().minRequiredVersion, '0.3.0');
  assert.ok(observed.length > 0);
});

test('validateSignedConfigPayloadBounds validates minShellVersion, reason, and updateDownloadUrl', () => {
  const validIssues = validateSignedConfigPayloadBounds({
    minShellVersion: '0.3.0',
    minShellVersionReason: 'Critical compatibility update',
    updateDownloadUrl: 'https://releases.open-design.ai/open-motion/desktop/stable',
  });
  assert.deepEqual(validIssues, []);

  const invalidIssues = validateSignedConfigPayloadBounds({
    minShellVersion: 'not-a-semver',
    minShellVersionReason: 'a'.repeat(501),
    updateDownloadUrl: 'https://evil.example.com/download',
  });
  const paths = invalidIssues.map(i => i.path);
  assert.ok(paths.includes('minShellVersion'));
  assert.ok(paths.includes('minShellVersionReason'));
  assert.ok(paths.includes('updateDownloadUrl'));
});
