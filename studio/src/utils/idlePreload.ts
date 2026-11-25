import { warmModule } from "./chunkLoadRecovery";

export type ModuleLoader = () => Promise<unknown>;

/** After the caller's readiness gate, start one optional download at a time at idle.
 * Disposing drops the remaining queue. Already-started imports are shared with clicks. */
export function scheduleIdlePreloads(loaders: readonly ModuleLoader[]): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  let disposed = false;
  let cancelIdle = () => {};
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
  next();
  return () => {
    disposed = true;
    cancelIdle();
    document.removeEventListener("visibilitychange", next);
  };
}
