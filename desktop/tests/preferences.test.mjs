import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DesktopPreferencesStore,
  readDesktopPreferences,
  resolveDesktopPreferenceValues,
  writeDesktopPreferences,
} from '../src/prefs.ts';
import {
  CapabilityRegistry,
  createPreferencesCapabilityModule,
} from '../src/capability-registry.ts';
import { HOST_CAPABILITIES, hostErr, hostOk } from '../../shared/desktop-contract.ts';

test('DesktopPreferencesStore persists, sanitizes, clears nulls, and resets keys atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmotion-prefs-'));
  const filePath = path.join(dir, 'desktop-prefs.json');
  try {
    const store = new DesktopPreferencesStore(filePath);
    assert.deepEqual(store.get(), {});
    assert.deepEqual(resolveDesktopPreferenceValues(store.get()), {
      confirmBeforeQuit: true,
      openAtLogin: false,
      autoCheckUpdates: true,
      hardwareAcceleration: true,
      locale: null,
      lastDownloadDir: null,
    });

    store.update({
      confirmBeforeQuit: false,
      autoCheckUpdates: false,
      hardwareAcceleration: false,
      locale: 'zh-CN',
      lastDownloadDir: '/tmp/exports',
    });
    const reloaded = readDesktopPreferences(filePath);
    assert.deepEqual(reloaded, {
      confirmBeforeQuit: false,
      autoCheckUpdates: false,
      hardwareAcceleration: false,
      locale: 'zh-CN',
      lastDownloadDir: '/tmp/exports',
    });

    // Clearing via null removes the persisted key cleanly.
    store.update({ locale: null, lastDownloadDir: null });
    assert.deepEqual(readDesktopPreferences(filePath), {
      confirmBeforeQuit: false,
      autoCheckUpdates: false,
      hardwareAcceleration: false,
    });

    // Single-key reset and full reset.
    store.reset('confirmBeforeQuit');
    assert.equal(readDesktopPreferences(filePath).confirmBeforeQuit, undefined);
    store.reset();
    assert.deepEqual(readDesktopPreferences(filePath), {});

    // Symlink target is refused on both read and write.
    const realTarget = path.join(dir, 'real.json');
    const linkTarget = path.join(dir, 'link.json');
    fs.writeFileSync(realTarget, '{"confirmBeforeQuit":false}\n');
    fs.symlinkSync(realTarget, linkTarget);
    assert.deepEqual(readDesktopPreferences(linkTarget), {});
    assert.equal(writeDesktopPreferences(linkTarget, { confirmBeforeQuit: true }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preferences capability validates allowlisted keys and rejects direct path injection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmotion-prefs-cap-'));
  const filePath = path.join(dir, 'desktop-prefs.json');
  try {
    const store = new DesktopPreferencesStore(filePath);
    const bootHwAccel = true;
    let openAtLogin = false;
    let relaunched = false;
    const registry = new CapabilityRegistry();
    const events = [];
    registry.addEventSink(msg => events.push(msg));

    const snapshot = () => {
      const values = resolveDesktopPreferenceValues(store.get(), { openAtLogin });
      return {
        values,
        descriptors: [
          { key: 'confirmBeforeQuit', supported: true },
          { key: 'openAtLogin', supported: true },
          { key: 'autoCheckUpdates', supported: true },
          { key: 'hardwareAcceleration', supported: true, requiresRestart: true },
          { key: 'locale', supported: true },
          { key: 'lastDownloadDir', supported: true, picker: true },
        ],
        platform: 'darwin',
        pendingRestartKeys: values.hardwareAcceleration !== bootHwAccel ? ['hardwareAcceleration'] : [],
      };
    };

    registry.register(
      createPreferencesCapabilityModule({
        getAll: () => snapshot(),
        set: async params => {
          if (params.key === 'openAtLogin') {
            openAtLogin = params.value;
          } else {
            store.update({ [params.key]: params.value });
          }
          const next = snapshot();
          registry.emit(HOST_CAPABILITIES.PREFERENCES, 'changed', next);
          return hostOk({
            key: params.key,
            value: next.values[params.key],
            applied: params.key === 'hardwareAcceleration' ? 'restart-required' : 'immediate',
            snapshot: next,
          });
        },
        reset: async params => {
          if (!params.key) {
            store.reset();
            openAtLogin = false;
          } else if (params.key === 'openAtLogin') {
            openAtLogin = false;
          } else {
            store.reset(params.key);
          }
          return hostOk(snapshot());
        },
        pickDownloadDir: async () => {
          store.update({ lastDownloadDir: '/opt/demo/Exports' });
          return hostOk({ canceled: false, path: '/opt/demo/Exports', snapshot: snapshot() });
        },
        relaunch: async () => {
          relaunched = true;
          return hostOk({ relaunching: true });
        },
      }),
    );

    const initial = await registry.invoke(HOST_CAPABILITIES.PREFERENCES, 'getAll');
    assert.equal(initial.ok, true);
    assert.equal(initial.data.values.confirmBeforeQuit, true);
    assert.deepEqual(initial.data.pendingRestartKeys, []);

    // Rejects arbitrary path writes to lastDownloadDir.
    const injectDir = await registry.invoke(HOST_CAPABILITIES.PREFERENCES, 'set', {
      key: 'lastDownloadDir',
      value: '/etc/passwd',
    });
    assert.equal(injectDir.ok, false);
    assert.equal(injectDir.error.code, 'INVALID_PARAMS');

    // Rejects security-sensitive / unknown keys (e.g. studioUrl).
    const injectOrigin = await registry.invoke(HOST_CAPABILITIES.PREFERENCES, 'set', {
      key: 'studioUrl',
      value: 'https://evil.example.com',
    });
    assert.equal(injectOrigin.ok, false);
    assert.equal(injectOrigin.error.code, 'INVALID_PARAMS');

    // Rejects malformed locale tag.
    const badLocale = await registry.invoke(HOST_CAPABILITIES.PREFERENCES, 'set', {
      key: 'locale',
      value: '../zh',
    });
    assert.equal(badLocale.ok, false);
    assert.equal(badLocale.error.code, 'INVALID_PARAMS');

    // Hardware acceleration reports restart-required and tracks pendingRestartKeys.
    const hwOff = await registry.invoke(HOST_CAPABILITIES.PREFERENCES, 'set', {
      key: 'hardwareAcceleration',
      value: false,
    });
    assert.equal(hwOff.ok, true);
    assert.equal(hwOff.data.applied, 'restart-required');
    assert.deepEqual(hwOff.data.snapshot.pendingRestartKeys, ['hardwareAcceleration']);

    // Toggling back clears pendingRestartKeys.
    const hwOn = await registry.invoke(HOST_CAPABILITIES.PREFERENCES, 'set', {
      key: 'hardwareAcceleration',
      value: true,
    });
    assert.equal(hwOn.ok, true);
    assert.deepEqual(hwOn.data.snapshot.pendingRestartKeys, []);

    // Native picker updates lastDownloadDir and reset clears it.
    const picked = await registry.invoke(HOST_CAPABILITIES.PREFERENCES, 'pickDownloadDir');
    assert.equal(picked.ok, true);
    assert.equal(picked.data.path, '/opt/demo/Exports');

    const cleared = await registry.invoke(HOST_CAPABILITIES.PREFERENCES, 'reset', {
      key: 'lastDownloadDir',
    });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.data.values.lastDownloadDir, null);

    // Relaunch invokes host handler.
    const relaunchRes = await registry.invoke(HOST_CAPABILITIES.PREFERENCES, 'relaunch');
    assert.equal(relaunchRes.ok, true);
    assert.equal(relaunched, true);
    assert.ok(events.some(event => event.capability === HOST_CAPABILITIES.PREFERENCES && event.event === 'changed'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preferences capability returns UNSUPPORTED when optional host handlers are absent', async () => {
  const registry = new CapabilityRegistry();
  registry.register(
    createPreferencesCapabilityModule({
      getAll: () => ({
        values: resolveDesktopPreferenceValues({}),
        descriptors: [{ key: 'confirmBeforeQuit', supported: true }],
        platform: 'linux',
        pendingRestartKeys: [],
      }),
      set: async () => hostErr('UNSUPPORTED', 'read-only test host'),
      reset: async () => hostOk({
        values: resolveDesktopPreferenceValues({}),
        descriptors: [],
        platform: 'linux',
        pendingRestartKeys: [],
      }),
    }),
  );

  const pickRes = await registry.invoke(HOST_CAPABILITIES.PREFERENCES, 'pickDownloadDir');
  assert.equal(pickRes.ok, false);
  assert.equal(pickRes.error.code, 'UNSUPPORTED');

  const relaunchRes = await registry.invoke(HOST_CAPABILITIES.PREFERENCES, 'relaunch');
  assert.equal(relaunchRes.ok, false);
  assert.equal(relaunchRes.error.code, 'UNSUPPORTED');
});
