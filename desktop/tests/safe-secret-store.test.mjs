import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemorySecretStore } from '../../packages/local-atoms/index.ts';
import { createElectronSafeSecretStore } from '../src/safe-secret-store.ts';

function createMockSafeStorage(options = { available: true }) {
  const prefix = Buffer.from('ENCv1:');
  return {
    isEncryptionAvailable: () => options.available,
    encryptString: plainText => {
      const payload = Buffer.from(plainText, 'utf8');
      const obfuscated = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) {
        obfuscated[i] = payload[i] ^ 0x5a;
      }
      return Buffer.concat([prefix, obfuscated]);
    },
    decryptString: encrypted => {
      if (!encrypted.subarray(0, prefix.length).equals(prefix)) {
        throw new Error('Bad ciphertext');
      }
      const body = encrypted.subarray(prefix.length);
      const plain = Buffer.alloc(body.length);
      for (let i = 0; i < body.length; i += 1) {
        plain[i] = body[i] ^ 0x5a;
      }
      return plain.toString('utf8');
    },
  };
}

test('createElectronSafeSecretStore encrypts at rest, persists across instances, and cleans up legacy fallback', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'om-safe-store-'));
  try {
    const safeStorage = createMockSafeStorage({ available: true });
    const fallback = createMemorySecretStore();
    await fallback.set('acct-legacy', 'legacy-secret-123');

    const store1 = createElectronSafeSecretStore({
      dataDir: tmpDir,
      safeStorage,
      fallbackStore: fallback,
    });

    // Reads legacy fallback when primary store does not yet hold the key
    assert.equal(await store1.get('acct-legacy'), 'legacy-secret-123');

    // Writing to primary store encrypts at rest and purges legacy fallback copy
    await store1.set('acct-legacy', 'new-secret-999');
    assert.equal(await fallback.get('acct-legacy'), null);

    const diskPath = path.join(tmpDir, 'secrets', 'safe-secrets.json');
    assert.equal(existsSync(diskPath), true);
    const rawOnDisk = readFileSync(diskPath, 'utf8');
    assert.equal(rawOnDisk.includes('new-secret-999'), false, 'Plaintext secret must never be written to disk');

    // Fresh store instance decrypts persisted secret cleanly
    const store2 = createElectronSafeSecretStore({
      dataDir: tmpDir,
      safeStorage,
      fallbackStore: fallback,
    });
    assert.equal(await store2.get('acct-legacy'), 'new-secret-999');

    // Tampered ciphertext fails closed (returns null)
    const parsed = JSON.parse(rawOnDisk);
    parsed.entries['acct-legacy'] = Buffer.from('corrupted-bytes').toString('base64');
    writeFileSync(diskPath, JSON.stringify(parsed), 'utf8');
    assert.equal(await store2.get('acct-legacy'), null);

    // Delete removes key cleanly
    assert.equal(await store2.delete('acct-legacy'), true);
    assert.equal(await store2.delete('acct-legacy'), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createElectronSafeSecretStore falls back lazily when safeStorage becomes available later and refuses symlinks', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'om-safe-fallback-'));
  try {
    const availability = { available: false };
    const safeStorage = createMockSafeStorage(availability);
    const fallback = createMemorySecretStore();

    const store = createElectronSafeSecretStore({
      dataDir: tmpDir,
      safeStorage,
      fallbackStore: fallback,
    });

    // While unavailable (e.g. before app.whenReady or headless Linux), delegates to fallback
    await store.set('acct-1', 'fallback-val');
    assert.equal(await fallback.get('acct-1'), 'fallback-val');
    assert.equal(await store.get('acct-1'), 'fallback-val');

    // Once safeStorage becomes available, new writes land in safeStorage and delete clears both
    availability.available = true;
    await store.set('acct-2', 'native-val');
    assert.equal(await store.get('acct-2'), 'native-val');
    assert.equal(await store.delete('acct-1'), true);
    assert.equal(await fallback.get('acct-1'), null);

    // Symlinked secret file must be refused
    const symlinkDir = mkdtempSync(path.join(os.tmpdir(), 'om-safe-symlink-'));
    try {
      const target = path.join(symlinkDir, 'outside.json');
      writeFileSync(target, '{}', 'utf8');
      mkdirSync(path.join(symlinkDir, 'secrets'), { recursive: true });
      symlinkSync(target, path.join(symlinkDir, 'secrets', 'safe-secrets.json'));

      const symlinkStore = createElectronSafeSecretStore({
        dataDir: symlinkDir,
        safeStorage,
      });
      await assert.rejects(() => symlinkStore.set('acct-evil', 'secret'), /symlink/i);
    } finally {
      rmSync(symlinkDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
