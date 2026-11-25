/**
 * Electron native `safeStorage`-backed SecretStore for `atom.credential`.
 *
 * Uses OS-native encryption (macOS Keychain / Windows DPAPI / Linux libsecret)
 * directly inside the Electron main process with zero subprocess spawns, while
 * persisting only encrypted base64 blobs under `<dataDir>/secrets/safe-secrets.json`
 * (mode 0600, atomic write, symlink-refusing).
 *
 * Availability is checked lazily on each operation so constructing the store
 * before `app.whenReady()` works cleanly and gracefully falls back if OS
 * encryption is unavailable (e.g., headless Linux without a secret service).
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { SecretStore } from '../../packages/local-atoms/index.ts';

const SAFE_SECRETS_SCHEMA_VERSION = 1;
const SAFE_SECRETS_FILE_NAME = 'safe-secrets.json';

export type ElectronSafeStorageLike = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
};

type PersistedSafeSecretsFile = {
  schemaVersion: number;
  entries: Record<string, string>;
};

export type ElectronSafeSecretStoreOptions = {
  dataDir: string;
  safeStorage: ElectronSafeStorageLike;
  fallbackStore?: SecretStore;
};

function assertNotSymlink(targetPath: string): void {
  if (!existsSync(targetPath)) return;
  if (lstatSync(targetPath).isSymbolicLink()) {
    throw new Error(`Refusing to access symlinked secret store path: ${targetPath}`);
  }
}

function resolveSafeSecretsFilePath(dataDir: string): { dirPath: string; filePath: string } {
  const dirPath = path.join(dataDir, 'secrets');
  const filePath = path.join(dirPath, SAFE_SECRETS_FILE_NAME);
  return { dirPath, filePath };
}

function readPersistedMap(dirPath: string, filePath: string): Record<string, string> {
  assertNotSymlink(dirPath);
  assertNotSymlink(filePath);
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PersistedSafeSecretsFile>;
    if (
      parsed &&
      parsed.schemaVersion === SAFE_SECRETS_SCHEMA_VERSION &&
      parsed.entries &&
      typeof parsed.entries === 'object' &&
      !Array.isArray(parsed.entries)
    ) {
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.entries)) {
        if (typeof value === 'string') {
          clean[key] = value;
        }
      }
      return clean;
    }
  } catch {
    // Corrupted file fails closed as empty map on reads.
  }
  return {};
}

function writePersistedMap(
  dirPath: string,
  filePath: string,
  entries: Record<string, string>,
): void {
  assertNotSymlink(dirPath);
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  assertNotSymlink(dirPath);
  assertNotSymlink(filePath);

  const payload: PersistedSafeSecretsFile = {
    schemaVersion: SAFE_SECRETS_SCHEMA_VERSION,
    entries,
  };
  const tmpPath = path.join(
    dirPath,
    `.${SAFE_SECRETS_FILE_NAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // Ignore chmod failures on filesystems that do not support POSIX modes (e.g. Windows).
  }
  renameSync(tmpPath, filePath);
}

export function createElectronSafeSecretStore(
  options: ElectronSafeSecretStoreOptions,
): SecretStore {
  const { dirPath, filePath } = resolveSafeSecretsFilePath(options.dataDir);
  const isAvailable = (): boolean => {
    try {
      return Boolean(options.safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  };

  return {
    async get(account: string): Promise<string | null> {
      if (!account) return null;
      if (!isAvailable()) {
        return options.fallbackStore ? await options.fallbackStore.get(account) : null;
      }
      const entries = readPersistedMap(dirPath, filePath);
      const encoded = entries[account];
      if (!encoded) {
        return options.fallbackStore ? await options.fallbackStore.get(account) : null;
      }
      try {
        return options.safeStorage.decryptString(Buffer.from(encoded, 'base64'));
      } catch {
        // Tampered or unreadable ciphertext fails closed without leaking error details.
        return null;
      }
    },

    async set(account: string, secret: string): Promise<void> {
      if (!account) {
        throw new Error('Secret account key must be a non-empty string');
      }
      if (!isAvailable()) {
        if (options.fallbackStore) {
          await options.fallbackStore.set(account, secret);
          return;
        }
        throw new Error('OS-backed safeStorage encryption is unavailable');
      }
      const encrypted = options.safeStorage.encryptString(secret);
      const entries = readPersistedMap(dirPath, filePath);
      entries[account] = Buffer.from(encrypted).toString('base64');
      writePersistedMap(dirPath, filePath, entries);
      // Clean up any legacy fallback entry for the same account so secrets do not linger in two stores.
      if (options.fallbackStore) {
        await options.fallbackStore.delete(account).catch(() => false);
      }
    },

    async delete(account: string): Promise<boolean> {
      if (!account) return false;
      let removedPrimary = false;
      if (existsSync(filePath)) {
        const entries = readPersistedMap(dirPath, filePath);
        if (Object.prototype.hasOwnProperty.call(entries, account)) {
          delete entries[account];
          writePersistedMap(dirPath, filePath, entries);
          removedPrimary = true;
        }
      }
      const removedFallback = options.fallbackStore
        ? await options.fallbackStore.delete(account).catch(() => false)
        : false;
      return removedPrimary || removedFallback;
    },
  };
}
