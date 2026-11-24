import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CapabilityRegistry, createWindowCapabilityModule } from '../src/capability-registry.ts';
import { buildDesktopDockMenuTemplate, buildDesktopMenuTemplate } from '../src/menu.ts';
import {
  DesktopPreferencesStore,
  readDesktopPreferences,
  writeDesktopPreferences,
} from '../src/prefs.ts';
import {
  buildRendererCrashRetryInfo,
  formatManualUpdateFeedback,
  isSafeHistoryNavigationTarget,
  RendererCrashGuard,
  resolveDownloadDirectory,
  resolveUpdaterMenuPresentation,
  TaskProgressCoordinator,
  WakeLockManager,
} from '../src/ux-controllers.ts';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('DesktopPreferencesStore persists quit confirmation and download dir atomically and refuses symlinks', () => {
  const dir = path.join(os.tmpdir(), `om-desktop-prefs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const prefsFile = path.join(dir, 'desktop-prefs.json');
    const store = new DesktopPreferencesStore(prefsFile);
    assert.deepEqual(store.get(), {});

    store.update({ confirmBeforeQuit: false, lastDownloadDir: dir });
    assert.equal(store.get().confirmBeforeQuit, false);
    assert.equal(store.get().lastDownloadDir, dir);

    const reloaded = new DesktopPreferencesStore(prefsFile);
    assert.deepEqual(reloaded.get(), { confirmBeforeQuit: false, lastDownloadDir: dir });

    // Corrupt file degrades gracefully.
    const corruptFile = path.join(dir, 'corrupt.json');
    writeFileSync(corruptFile, '{not-json', 'utf8');
    assert.deepEqual(readDesktopPreferences(corruptFile), {});

    // Symlink targets are refused on both read and write.
    const realTarget = path.join(dir, 'real.json');
    const symlinkFile = path.join(dir, 'link.json');
    writeFileSync(realTarget, JSON.stringify({ confirmBeforeQuit: false }), 'utf8');
    symlinkSync(realTarget, symlinkFile);
    assert.deepEqual(readDesktopPreferences(symlinkFile), {});
    assert.equal(writeDesktopPreferences(symlinkFile, { confirmBeforeQuit: true }), false);

    // Download directory resolver validates directory existence.
    assert.equal(resolveDownloadDirectory(dir, '/fallback'), dir);
    assert.equal(resolveDownloadDirectory(path.join(dir, 'missing-folder'), '/fallback'), '/fallback');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RendererCrashGuard distinguishes clean exits, OOM, and rolling crash loops', () => {
  const guard = new RendererCrashGuard({ windowMs: 60_000, loopThreshold: 3 });

  assert.equal(guard.recordExit('clean-exit', 1000).recover, false);
  assert.equal(guard.recordExit('killed', 1500).recover, false);

  const first = guard.recordExit('oom', 2000);
  assert.equal(first.recover, true);
  assert.equal(first.isOom, true);
  assert.equal(first.isCrashLoop, false);
  const oomInfo = buildRendererCrashRetryInfo(first, { reason: 'oom', exitCode: 137 }, 'zh-CN');
  assert.equal(oomInfo.code, 'RENDERER_OOM');
  assert.match(oomInfo.badge, /内存不足/);

  const second = guard.recordExit('crashed', 10_000);
  assert.equal(second.isCrashLoop, false);

  const third = guard.recordExit('crashed', 20_000);
  assert.equal(third.isCrashLoop, true);
  assert.equal(third.crashCount, 3);
  const loopInfo = buildRendererCrashRetryInfo(third, { reason: 'crashed', exitCode: 11 }, 'en-US');
  assert.equal(loopInfo.code, 'RENDERER_CRASH');
  assert.match(loopInfo.badge, /Repeated crash/);

  // Window expiration resets loop count.
  const later = guard.recordExit('crashed', 120_000);
  assert.equal(later.isCrashLoop, false);
  assert.equal(later.crashCount, 1);
});

test('TaskProgressCoordinator merges downloads and renderer tasks into unified progress bar values', () => {
  const emitted = [];
  const coordinator = new TaskProgressCoordinator(value => emitted.push(value));

  coordinator.upsertTask('gen-1', 'indeterminate');
  assert.equal(coordinator.getValue(), 2);

  coordinator.upsertDownload('dl-1', 50, 100);
  assert.equal(coordinator.getValue(), 0.5);

  coordinator.upsertTask('gen-2', 1.0);
  assert.equal(coordinator.getValue(), 0.75);

  coordinator.removeDownload('dl-1');
  assert.equal(coordinator.getValue(), 1);

  coordinator.clearTasks();
  assert.equal(coordinator.getValue(), -1);
  assert.deepEqual(emitted, [2, 0.5, 0.75, 1, -1]);
});

test('WakeLockManager ref-counts leases, clears by prefix, and releases on stop', () => {
  let nextId = 10;
  const started = [];
  const stopped = [];
  const manager = new WakeLockManager({
    start: () => {
      const id = ++nextId;
      started.push(id);
      return id;
    },
    stop: id => {
      stopped.push(id);
    },
  });

  assert.equal(manager.isActive(), false);
  assert.deepEqual(manager.acquire('download:1', 'download'), { active: true, leaseCount: 1 });
  assert.deepEqual(manager.acquire('task:render-1', 'render'), { active: true, leaseCount: 2 });
  assert.equal(started.length, 1);

  assert.equal(manager.releasePrefix('task:'), 1);
  assert.equal(manager.isActive(), true);
  assert.deepEqual(manager.getActiveLeaseIds(), ['download:1']);

  assert.deepEqual(manager.release('download:1'), { active: false, leaseCount: 0 });
  assert.deepEqual(stopped, [11]);
});

test('Updater menu presentation and manual feedback handle downloaded, up-to-date, and error states', () => {
  const downloadedState = {
    status: 'downloaded',
    currentVersion: '0.2.1',
    availableVersion: '0.2.2',
  };
  const enMenu = resolveUpdaterMenuPresentation(downloadedState, 'en-US');
  assert.equal(enMenu.action, 'install');
  assert.equal(enMenu.label, 'Restart to Update (v0.2.2)…');

  const zhMenu = resolveUpdaterMenuPresentation(downloadedState, 'zh-CN');
  assert.equal(zhMenu.action, 'install');
  assert.equal(zhMenu.label, '重启以更新 (v0.2.2)…');

  const downloadingMenu = resolveUpdaterMenuPresentation(
    { status: 'downloading', currentVersion: '0.2.1', progress: 64.4 },
    'en-US',
  );
  assert.equal(downloadingMenu.enabled, false);
  assert.equal(downloadingMenu.label, 'Downloading Update (64%)…');

  const feedbackDownloaded = formatManualUpdateFeedback(downloadedState, 'en-US');
  assert.equal(feedbackDownloaded?.primaryAction, 'restart');

  const feedbackUpToDate = formatManualUpdateFeedback(
    { status: 'up-to-date', currentVersion: '0.2.1' },
    'zh-CN',
  );
  assert.equal(feedbackUpToDate?.primaryAction, 'none');
  assert.match(feedbackUpToDate?.message ?? '', /0\.2\.1/);

  const feedbackError = formatManualUpdateFeedback(
    { status: 'error', currentVersion: '0.2.1', message: 'ETIMEDOUT' },
    'en-US',
  );
  assert.equal(feedbackError?.primaryAction, 'retry');
  assert.equal(feedbackError?.detail, 'ETIMEDOUT');
});

test('History navigation guard blocks local fallback pages, /auth routes, and foreign origins', () => {
  const allowed = new Set(['https://open-design.ai', 'https://preview.open-design.ai']);
  assert.equal(isSafeHistoryNavigationTarget('https://open-design.ai/studio/proj-1', allowed), true);
  assert.equal(isSafeHistoryNavigationTarget('https://preview.open-design.ai/explore', allowed), true);
  assert.equal(isSafeHistoryNavigationTarget('https://open-design.ai/auth/callback', allowed), false);
  assert.equal(isSafeHistoryNavigationTarget('https://open-design.ai/auth', allowed), false);
  assert.equal(isSafeHistoryNavigationTarget('file:///Applications/OpenDesign.app/dist/retry.html', allowed), false);
  assert.equal(isSafeHistoryNavigationTarget('https://evil.example.com/', allowed), false);
  assert.equal(isSafeHistoryNavigationTarget(undefined, allowed), false);
});

test('Menu integrates Restart-to-Update, Back/Forward navigation, and Confirm-Before-Quitting checkbox', () => {
  let installed = 0;
  let backCalls = 0;
  let forwardCalls = 0;
  let toggledConfirm = null;

  const template = buildDesktopMenuTemplate({
    platform: 'darwin',
    appVersion: '0.2.1',
    locale: 'zh-CN',
    updateState: { status: 'downloaded', currentVersion: '0.2.1', availableVersion: '0.3.0' },
    confirmBeforeQuit: true,
    canGoBack: true,
    canGoForward: false,
    onAction: () => {},
    onOpenUrl: () => {},
    onInstallUpdate: () => {
      installed += 1;
    },
    onNavigateBack: () => {
      backCalls += 1;
    },
    onNavigateForward: () => {
      forwardCalls += 1;
    },
    onToggleConfirmBeforeQuit: value => {
      toggledConfirm = value;
    },
  });

  const flat = template.flatMap(group => (Array.isArray(group.submenu) ? group.submenu : []));
  const restartItem = flat.find(item => item.label === '重启以更新 (v0.3.0)…');
  assert.ok(restartItem, 'Expected dynamic Restart to Update menu item');
  restartItem.click?.({}, undefined, {});
  assert.equal(installed, 1);

  const backItem = flat.find(item => item.label === '后退');
  const forwardItem = flat.find(item => item.label === '前进');
  assert.equal(backItem?.accelerator, 'Cmd+[');
  assert.equal(backItem?.enabled, true);
  assert.equal(forwardItem?.accelerator, 'Cmd+]');
  assert.equal(forwardItem?.enabled, false);
  backItem?.click?.({}, undefined, {});
  forwardItem?.click?.({}, undefined, {});
  assert.equal(backCalls, 1);
  assert.equal(forwardCalls, 1);

  const confirmItem = flat.find(item => item.label === '退出前确认');
  assert.equal(confirmItem?.type, 'checkbox');
  assert.equal(confirmItem?.checked, true);
  confirmItem?.click?.({ checked: false }, undefined, {});
  assert.equal(toggledConfirm, false);

  const dockMenu = buildDesktopDockMenuTemplate({
    locale: 'en-US',
    updateState: { status: 'downloaded', currentVersion: '0.2.1', availableVersion: '0.3.0' },
    onAction: () => {},
    onInstallUpdate: () => {
      installed += 1;
    },
  });
  dockMenu.find(item => item.label === 'Restart to Update (v0.3.0)…')?.click?.({}, undefined, {});
  assert.equal(installed, 2);
});

test('Window capability supports additive system theme, task progress, wake lock, and notification methods', async () => {
  const calls = [];
  const registry = new CapabilityRegistry();
  registry.register(
    createWindowCapabilityModule({
      getChromeState: () => ({
        platform: 'darwin',
        titleBarStyle: 'hiddenInset',
        titleBarHeight: 46,
        insetLeft: 78,
        insetRight: 0,
        fullscreen: false,
        maximized: false,
        customWindowControls: false,
      }),
      setTheme: theme => {
        calls.push(['setTheme', theme]);
      },
      minimize: () => {},
      toggleMaximize: () => {},
      close: () => {},
      openExternal: () => ({ ok: true }),
      notifyRendererReady: () => {},
      setTaskProgress: input => {
        calls.push(['setTaskProgress', input]);
        return { progress: 0.4 };
      },
      acquireWakeLock: input => {
        calls.push(['acquireWakeLock', input]);
        return { active: true, leaseCount: 1 };
      },
      releaseWakeLock: input => {
        calls.push(['releaseWakeLock', input]);
        return { active: false, leaseCount: 0 };
      },
      notify: input => {
        calls.push(['notify', input]);
        return { delivered: true, bounced: true };
      },
    }),
  );

  assert.deepEqual(await registry.invoke('window', 'setTheme', { theme: 'system' }), {
    ok: true,
    data: { theme: 'system' },
  });
  assert.deepEqual(
    await registry.invoke('window', 'setTaskProgress', { taskId: 'render-1', progress: 0.4 }),
    { ok: true, data: { progress: 0.4 } },
  );
  assert.equal(
    (await registry.invoke('window', 'setTaskProgress', { taskId: 'render-1', progress: 5 })).error?.code,
    'INVALID_PARAMS',
  );
  assert.deepEqual(
    await registry.invoke('window', 'acquireWakeLock', { taskId: 'render-1', ttlMs: 60_000 }),
    { ok: true, data: { active: true, leaseCount: 1 } },
  );
  assert.deepEqual(
    await registry.invoke('window', 'releaseWakeLock', { taskId: 'render-1' }),
    { ok: true, data: { active: false, leaseCount: 0 } },
  );
  assert.deepEqual(
    await registry.invoke('window', 'notify', { title: 'Export ready', body: 'demo.mp4' }),
    { ok: true, data: { delivered: true, bounced: true } },
  );
  assert.equal(calls.length, 5);
});

test('retry.html supports live theme sync, crash badge/title overrides, and safe online auto-reconnect', () => {
  const retryHtml = readFileSync(path.join(desktopRoot, 'src', 'retry.html'), 'utf8');
  assert.ok(retryHtml.includes('window.__setDesktopTheme'));
  assert.ok(retryHtml.includes("window.addEventListener('online'"));
  assert.ok(retryHtml.includes("params.get('badge')"));
  assert.ok(retryHtml.includes("params.get('title')"));
  assert.equal(/backdrop-filter/i.test(retryHtml), false);
  assert.equal(retryHtml.includes('innerHTML'), false);
});
