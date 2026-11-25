import { Hono } from 'hono';
import {
  handleStudioError,
  type DisklessStudioDeps,
  type StudioVariables,
} from './context.ts';
import { createContainerFontCatalog } from './fonts-catalog.ts';
import { createStudioCompositionFilmstripsRoutes } from './routes/composition-filmstrips.ts';
import { createStudioFileMutationsRoutes } from './routes/file-mutations.ts';
import { createStudioFilesRoutes } from './routes/files.ts';
import { createStudioFontsRoutes } from './routes/fonts.ts';
import { createStudioGsapRoutes } from './routes/gsap.ts';
import { createStudioHistoryRoutes } from './routes/history.ts';
import { createStudioSystemRoutes } from './routes/lint-selection-system.ts';
import { createStudioMediaRoutes } from './routes/media.ts';
import { createStudioPreviewRoutes } from './routes/preview.ts';
import { createStudioProjectsRoutes } from './routes/projects.ts';
import { createStudioRenderRoutes } from './routes/render.ts';

export type { DisklessStudioDeps, StudioEventBusPort, StudioQueuesPort, StudioVariables } from './context.ts';
export { createContainerFontCatalog, type ContainerFontCatalog } from './fonts-catalog.ts';
export {
  DELETED_VERSION,
  PRESIGNED_REDIRECT_HEADERS,
  buildContentDisposition,
  computePreviewImpact,
  createWriteToken,
  fileContentVersion,
  formatVersionFromSha256,
  getMimeType,
  parseSha256FromVersion,
  sha256Hex,
} from './etag.ts';
export {
  InMemoryVirtualProject,
  listVirtualCompositions,
  normalizeVirtualPath,
  resolveVirtualPath,
  virtualDirname,
  type VirtualFileRecord,
  type VirtualProjectReader,
} from './virtual-project-store.ts';
export {
  buildSubCompositionHtmlInMemory,
  bundlePreviewInMemory,
  createCachedFontFetch,
  previewEtag,
  type BundlePreviewOptions,
  type FontCssCachePort,
} from './engine/preview-bundler.ts';
export { lintProjectInMemory } from './engine/lint-project.ts';
export {
  infoInMemory,
  timelineInMemory,
  type ProjectInfoResult,
  type ProjectTimelineResult,
  type TimelineRow,
  type TimelineTrack,
} from './engine/inspect.ts';
export {
  applyGsapMutationsInMemory,
  extractGsapScriptBlock,
  parseGsapAnimationsFromHtml,
  validateGsapMutationPayload,
} from './engine/gsap-mutations.ts';

/**
 * Create the complete Diskless Studio Hono application (Option B per Spike 1).
 *
 * ZERO local `projectDir` reads or writes — all project files, versions, history,
 * media metadata, and renders are backed by PostgreSQL + S3 CAS + Redis.
 */
export function createDisklessStudioApp(deps: DisklessStudioDeps): Hono<{ Variables: StudioVariables }> {
  const fontCatalog =
    deps.fontCatalog ??
    createContainerFontCatalog({
      fontsDir: deps.fontsDir,
      runtimeRoot: deps.runtimeRoot,
    });

  const enrichedDeps: DisklessStudioDeps = {
    ...deps,
    fontCatalog,
  };

  const app = new Hono<{ Variables: StudioVariables }>();

  app.onError((err, c) => handleStudioError(c, err));

  app.route('/', createStudioProjectsRoutes(enrichedDeps));
  app.route('/', createStudioFilesRoutes(enrichedDeps));
  app.route('/', createStudioFileMutationsRoutes(enrichedDeps));
  app.route('/', createStudioGsapRoutes(enrichedDeps));
  app.route('/', createStudioPreviewRoutes(enrichedDeps));
  app.route('/', createStudioHistoryRoutes(enrichedDeps));
  app.route('/', createStudioRenderRoutes(enrichedDeps));
  app.route('/', createStudioCompositionFilmstripsRoutes(enrichedDeps));
  app.route('/', createStudioMediaRoutes(enrichedDeps));
  app.route('/', createStudioFontsRoutes(enrichedDeps, fontCatalog));
  app.route('/', createStudioSystemRoutes(enrichedDeps));

  return app;
}
