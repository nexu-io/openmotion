// @vitest-environment happy-dom
import { warmModule } from './chunkLoadRecovery';
import { describe, expect, it, vi } from 'vitest';
import { attemptChunkReload, bindVitePreloadErrorReload, isChunkLoadError } from './chunkReload';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('chunkReload', () => {
  it('recognizes stale dynamic-import and chunk load errors only', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:62280/editor-assets/App-old.js'))).toBe(true);
    expect(isChunkLoadError(new Error('Loading CSS chunk 42 failed'))).toBe(true);
    expect(isChunkLoadError(new Error('ChunkLoadError: Loading chunk App failed'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('reloads once per URL within the cooldown window and avoids reload loops', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    let clock = 1_000;
    const urlA = 'http://127.0.0.1:62280/?project=project&session=project#project/project';
    const urlB = 'http://127.0.0.1:62280/?project=other&session=other#project/other';

    expect(attemptChunkReload({ href: urlA, now: () => clock, storage, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    // Second failure on the same URL within cooldown must not loop.
    clock += 3_000;
    expect(attemptChunkReload({ href: urlA, now: () => clock, storage, reload })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);

    // Different URL or expired cooldown can reload again.
    expect(attemptChunkReload({ href: urlB, now: () => clock, storage, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);

    clock += 20_000;
    expect(attemptChunkReload({ href: urlB, now: () => clock, storage, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('keeps a failed speculative import from refreshing the editor, while a simultaneous required failure still recovers', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const dispose = bindVitePreloadErrorReload(window, { storage: memoryStorage(), reload });
    const raise = (error: Error) => window.dispatchEvent(Object.assign(new Event('vite:preloadError'), { payload: error }));
    try {
      await warmModule(async () => {
        const error = new Error('failed optional download');
        raise(error);
        throw error;
      });
      await vi.runAllTimersAsync();
      expect(reload).not.toHaveBeenCalled();
      await warmModule(async () => { raise(new Error('failed required download')); });
      await vi.runAllTimersAsync();
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it('handles vite:preloadError by preventing default and reloading once', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const cleanup = bindVitePreloadErrorReload(window, {
      href: 'http://127.0.0.1:62280/?project=project',
      now: () => 5_000,
      storage,
      reload,
    });

    const first = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    const second = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);

    cleanup();
  });
});
