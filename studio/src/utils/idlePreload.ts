import { warmModule } from "./chunkLoadRecovery";

export type ModuleLoader = () => Promise<unknown>;

export type IdlePreloadOptions = {
  /** Wait until page load completes plus this delay before scheduling speculative downloads. */
  delayMs?: number;
};

/** After the caller's readiness gate, start one optional download at a time at idle.
 * Disposing drops the remaining queue. Already-started imports are shared with clicks. */
export function scheduleIdlePreloads(
  loaders: readonly ModuleLoader[],
  options?: IdlePreloadOptions,
): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  const delayMs = Math.max(0, options?.delayMs ?? 0);
  let disposed = false;
  let cancelIdle = () => {};
  let cancelDelay = () => {};
  let index = 0;
  function next() {
    if (disposed || connection?.saveData || index >= loaders.length) return;
    if (document.hidden) {
      document.addEventListener("visibilitychange", next, { once: true });
      return;
    }
    const start = () => {
      if (disposed) return;
      if (document.hidden) return next();
      const load = loaders[index++];
      if (load) void warmModule(load).then(next);
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(start);
      cancelIdle = () => window.cancelIdleCallback(id);
    } else {
      const id = window.setTimeout(start, 100);
      cancelIdle = () => window.clearTimeout(id);
    }
  }
  const startAfterDelay = () => {
    if (disposed || connection?.saveData || index >= loaders.length) return;
    const timer = window.setTimeout(() => {
      cancelDelay = () => {};
      next();
    }, delayMs);
    cancelDelay = () => window.clearTimeout(timer);
  };
  if (delayMs > 0) {
    if (document.readyState === "complete") {
      startAfterDelay();
    } else {
      const onLoad = () => {
        cancelDelay = () => {};
        startAfterDelay();
      };
      window.addEventListener("load", onLoad, { once: true });
      cancelDelay = () => window.removeEventListener("load", onLoad);
    }
  } else {
    next();
  }
  return () => {
    disposed = true;
    cancelDelay();
    cancelIdle();
    document.removeEventListener("visibilitychange", next);
  };
}
