import type { ComponentType } from 'react';
import { lazyWithChunkReload } from '../utils/chunkReload';

/**
 * Canonical source paths (relative to `studio/src/`) for lazy-loaded workspace
 * surfaces and overlays. Shared with `shellBoundary.test.ts` so the static
 * shell boundary guard stays aligned with the lazy route registry.
 */
export const LAZY_PAGE_MODULE_PATHS = [
  'motion/ExploreStudios.tsx',
  'motion/MotionStudioPage.tsx',
  'motion/CinemaStudioPage.tsx',
  'motion/CreativeWorkspace.tsx',
  'design/scenes/DesignScenePage.tsx',
  'design/DesignProjectEditor.tsx',
  'scenario/ScenarioHub.tsx',
  'scenario/ScenarioWorkspace.tsx',
  'motion/game/GameStudio.tsx',
  'motion/AssetsPage.tsx',
  'motion/SkillsPage.tsx',
  'motion/ModelOverview.tsx',
  'motion/ModelHub.tsx',
  'motion/SettingsCenter.tsx',
  'motion/McpConnectionPage.tsx',
  'motion/BrandKitPage.tsx',
  'motion/ConnectionDialog.tsx',
] as const;

const preloaders: Array<() => Promise<unknown>> = [];

function lazyPage<T extends ComponentType<any>>(importer: () => Promise<{ default: T }>) {
  let pending: Promise<{ default: T }> | null = null;
  const load = () => {
    if (!pending) {
      pending = importer().catch(error => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
  preloaders.push(load);
  return lazyWithChunkReload(load);
}

/** Preload all lazy workspace page chunks (used by tests to avoid transform-time suspense races). */
export function preloadAllWorkspacePages(): Promise<unknown[]> {
  return Promise.all(preloaders.map(load => load()));
}

export const LazyExploreStudios = lazyPage(() =>
  import('../motion/ExploreStudios').then(module => ({ default: module.ExploreStudios })),
);

export const LazyMotionStudioPage = lazyPage(() =>
  import('../motion/MotionStudioPage').then(module => ({ default: module.MotionStudioPage })),
);

export const LazyCinemaStudioPage = lazyPage(() =>
  import('../motion/CinemaStudioPage').then(module => ({ default: module.CinemaStudioPage })),
);

export const LazyCreativeWorkspace = lazyPage(() =>
  import('../motion/CreativeWorkspace').then(module => ({ default: module.CreativeWorkspace })),
);

export const LazyDesignScenePage = lazyPage(() =>
  import('../design/scenes/DesignScenePage').then(module => ({ default: module.DesignScenePage })),
);

export const LazyDesignProjectEditor = lazyPage(() =>
  import('../design/DesignProjectEditor').then(module => ({ default: module.DesignProjectEditor })),
);

export const LazyScenarioHub = lazyPage(() =>
  import('../scenario/ScenarioHub').then(module => ({ default: module.ScenarioHub })),
);

export const LazyScenarioWorkspace = lazyPage(() =>
  import('../scenario/ScenarioWorkspace').then(module => ({ default: module.ScenarioWorkspace })),
);

export const LazyGameStudio = lazyPage(() =>
  import('../motion/game/GameStudio').then(module => ({ default: module.GameStudio })),
);

export const LazyAssetsPage = lazyPage(() =>
  import('../motion/AssetsPage').then(module => ({ default: module.AssetsPage })),
);

export const LazySkillsPage = lazyPage(() =>
  import('../motion/SkillsPage').then(module => ({ default: module.SkillsPage })),
);

export const LazyModelOverview = lazyPage(() =>
  import('../motion/ModelOverview').then(module => ({ default: module.ModelOverview })),
);

export const LazyModelHub = lazyPage(() =>
  import('../motion/ModelHub').then(module => ({ default: module.ModelHub })),
);

export const LazySettingsCenter = lazyPage(() =>
  import('../motion/SettingsCenter').then(module => ({ default: module.SettingsCenter })),
);

export const LazyMcpConnectionPage = lazyPage(() =>
  import('../motion/McpConnectionPage').then(module => ({ default: module.McpConnectionPage })),
);

export const LazyBrandKitPage = lazyPage(() =>
  import('../motion/BrandKitPage').then(module => ({ default: module.BrandKitPage })),
);

export const LazyConnectionDialog = lazyPage(() =>
  import('../motion/ConnectionDialog').then(module => ({ default: module.ConnectionDialog })),
);
