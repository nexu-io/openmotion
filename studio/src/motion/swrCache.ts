export type SwrCacheScope = 'public' | 'private';

type SwrEnvelope<T> = {
  v: 1;
  savedAt: number;
  expiresAt: number;
  data: T;
};

const STORAGE_PREFIX = 'om:swr:v1:';
const PRIVATE_SCOPE_STORAGE_KEY = 'om:swr:v1:private-scope';
const DEFAULT_PUBLIC_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PRIVATE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PUBLIC_BYTES = 512 * 1024;
const MAX_PRIVATE_BYTES = 256 * 1024;

const memoryCache = new Map<string, SwrEnvelope<unknown>>();
let activePrivateScope: string | null | undefined = undefined;
let testModeOverride: boolean | null = null;

function isTestRuntime(): boolean {
  if (testModeOverride !== null) return !testModeOverride;
  const metaEnv = (import.meta as ImportMeta & { env?: { MODE?: string } }).env;
  if (metaEnv?.MODE === 'test') return true;
  if (typeof process !== 'undefined' && process.env?.VITEST) return true;
  return false;
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function getPrivateSwrIdentity(): string | null {
  if (activePrivateScope !== undefined) {
    return activePrivateScope;
  }
  const storage = getStorage();
  if (!storage) return null;
  try {
    const persisted = storage.getItem(PRIVATE_SCOPE_STORAGE_KEY);
    activePrivateScope = persisted && persisted.trim() ? persisted.trim() : null;
    return activePrivateScope;
  } catch {
    return null;
  }
}

/**
 * Binds private SWR snapshots to the verified account + workspace identity.
 * Any identity switch (user change, workspace switch, or sign-out) immediately
 * clears previously cached private entries so cross-account/cross-workspace
 * data is never restored from storage.
 */
export function setPrivateSwrIdentity(
  identity: { userId?: string | null; workspaceId?: string | null } | null,
): boolean {
  const userPart = identity?.userId?.trim() || '';
  const workspacePart = identity?.workspaceId?.trim() || '';
  const nextScope = userPart || workspacePart ? `${userPart}:${workspacePart}` : null;
  const currentScope = getPrivateSwrIdentity();
  if (currentScope === nextScope) {
    return false;
  }
  clearSwrScope('private');
  activePrivateScope = nextScope;
  const storage = getStorage();
  if (storage) {
    try {
      if (nextScope) {
        storage.setItem(PRIVATE_SCOPE_STORAGE_KEY, nextScope);
      } else {
        storage.removeItem(PRIVATE_SCOPE_STORAGE_KEY);
      }
    } catch {
      // Ignore storage write failures.
    }
  }
  return true;
}

function fullKey(scope: SwrCacheScope, key: string): string | null {
  if (scope === 'private') {
    const identity = getPrivateSwrIdentity();
    if (!identity) return null;
    return `${STORAGE_PREFIX}private:${identity}:${key}`;
  }
  return `${STORAGE_PREFIX}${scope}:${key}`;
}

export function setSwrCacheEnabledForTests(enabled: boolean | null): void {
  testModeOverride = enabled;
}

export function readSwrCache<T>(scope: SwrCacheScope, key: string): T | null {
  if (isTestRuntime()) return null;
  const k = fullKey(scope, key);
  if (!k) return null;
  const now = Date.now();
  const inMem = memoryCache.get(k);
  if (inMem) {
    if (inMem.expiresAt > now) return inMem.data as T;
    memoryCache.delete(k);
  }
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(k);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SwrEnvelope<T>> | null;
    if (!parsed || parsed.v !== 1 || typeof parsed.expiresAt !== 'number' || !('data' in parsed)) {
      storage.removeItem(k);
      return null;
    }
    if (parsed.expiresAt <= now) {
      storage.removeItem(k);
      return null;
    }
    const envelope: SwrEnvelope<T> = {
      v: 1,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : now,
      expiresAt: parsed.expiresAt,
      data: parsed.data as T,
    };
    memoryCache.set(k, envelope);
    return envelope.data;
  } catch {
    try { storage.removeItem(k); } catch {}
    return null;
  }
}

export function writeSwrCache<T>(
  scope: SwrCacheScope,
  key: string,
  data: T,
  ttlMs = scope === 'public' ? DEFAULT_PUBLIC_TTL_MS : DEFAULT_PRIVATE_TTL_MS,
): void {
  if (isTestRuntime()) return;
  const k = fullKey(scope, key);
  if (!k) return;
  const now = Date.now();
  const envelope: SwrEnvelope<T> = {
    v: 1,
    savedAt: now,
    expiresAt: now + Math.max(1000, ttlMs),
    data,
  };
  memoryCache.set(k, envelope);
  const storage = getStorage();
  if (!storage) return;
  try {
    const serialized = JSON.stringify(envelope);
    const maxBytes = scope === 'public' ? MAX_PUBLIC_BYTES : MAX_PRIVATE_BYTES;
    if (serialized.length > maxBytes) return;
    storage.setItem(k, serialized);
  } catch {
    // Ignore storage quota / privacy mode errors; in-memory cache still serves the session.
  }
}

export function clearSwrScope(scope: SwrCacheScope): void {
  const prefix = `${STORAGE_PREFIX}${scope}:`;
  for (const key of [...memoryCache.keys()]) {
    if (key.startsWith(prefix)) memoryCache.delete(key);
  }
  const storage = getStorage();
  if (!storage) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(prefix)) keysToRemove.push(k);
    }
    for (const k of keysToRemove) storage.removeItem(k);
  } catch {
    // Ignore storage enumeration failures.
  }
}

export function clearPrivateSwrCache(): void {
  clearSwrScope('private');
  activePrivateScope = null;
  const storage = getStorage();
  if (storage) {
    try {
      storage.removeItem(PRIVATE_SCOPE_STORAGE_KEY);
    } catch {
      // Ignore storage removal errors.
    }
  }
}

export function clearAllSwrCache(): void {
  clearSwrScope('public');
  clearSwrScope('private');
}
