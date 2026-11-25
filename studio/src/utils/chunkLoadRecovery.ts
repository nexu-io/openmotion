const CHUNK_ERROR_PATTERN =
  /dynamically imported module|loading (?:css )?chunk|importing a module script|chunkloaderror/i;

const RELOAD_STORAGE_KEY = 'openmotion.chunk-reload';
const RELOAD_COOLDOWN_MS = 15_000;

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return CHUNK_ERROR_PATTERN.test(message);
}

export type ReloadDeps = {
  href?: string;
  now?: () => number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  reload?: () => void;
};

/**
 * Triggers a single full-page reload when a lazily loaded JS/CSS chunk goes stale
 * after Studio is rebuilt or upgraded while a tab is still open.
 * Returns true if a reload was initiated; false if one was already attempted
 * recently for the same URL (preventing reload loops when offline).
 */
export function attemptChunkReload(deps: ReloadDeps = {}): boolean {
  if (typeof window === 'undefined' && !deps.reload) return false;
  const href = deps.href ?? window.location.href;
  const now = (deps.now ?? Date.now)();
  const reload = deps.reload ?? (() => window.location.reload());

  let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null;
  if ('storage' in deps) {
    storage = deps.storage ?? null;
  } else {
    try {
      storage = window.sessionStorage;
    } catch {
      storage = null;
    }
  }

  if (storage) {
    try {
      const raw = storage.getItem(RELOAD_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { href?: unknown; at?: unknown };
        if (
          parsed.href === href &&
          typeof parsed.at === 'number' &&
          now - parsed.at >= 0 &&
          now - parsed.at < RELOAD_COOLDOWN_MS
        ) {
          return false;
        }
      }
      storage.setItem(RELOAD_STORAGE_KEY, JSON.stringify({ href, at: now }));
    } catch {
      // If sessionStorage is blocked, avoid an unguarded infinite reload loop.
      return false;
    }
  }

  reload();
  return true;
}

let warming = 0;
const warmFailures = new WeakSet<object>();

/** A speculative import may fail when an editor tab outlives a release. Leave the
 * current editor alone; lazyWithChunkReload recovers if the feature is actually opened. */
export async function warmModule(load: () => Promise<unknown>): Promise<void> {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return;
  warming++;
  try {
    await load();
  } catch (error) {
    if (error && typeof error === "object") warmFailures.add(error);
  } finally {
    warming--;
  }
}

export function bindVitePreloadErrorReload(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  deps?: ReloadDeps,
): () => void {
  const onPreloadError = (event: Event) => {
    const error = (event as Event & { payload?: Error }).payload;
    if (warming && error && typeof error === "object") {
      // Vite emits this before rejecting import(). Let the caller identify the
      // actual rejection, even if another, required import failed concurrently.
      setTimeout(() => { if (!warmFailures.has(error)) attemptChunkReload(deps); }, 0);
      return;
    }
    if (attemptChunkReload(deps)) {
      event.preventDefault();
    }
  };
  target.addEventListener('vite:preloadError', onPreloadError);
  return () => target.removeEventListener('vite:preloadError', onPreloadError);
}
