import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { attemptChunkReload, isChunkLoadError, type ReloadDeps } from './chunkLoadRecovery';
export { attemptChunkReload, bindVitePreloadErrorReload, isChunkLoadError } from './chunkLoadRecovery';

export function lazyWithChunkReload<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
  deps?: ReloadDeps,
): LazyExoticComponent<T> {
  return lazy(() =>
    importer().catch((error: unknown) => {
      if (isChunkLoadError(error) && attemptChunkReload(deps)) {
        // Keep Suspense fallback visible while the browser reloads the fresh entry HTML.
        return new Promise<never>(() => {});
      }
      throw error;
    }),
  );
}
