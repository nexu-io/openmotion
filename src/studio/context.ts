import type { Context } from 'hono';
import {
  hasMinRole,
  requireProgrammaticEdit,
  hasScope,
  type AuthContext,
  type PatScope,
  type WorkspaceRole,
} from '../contracts/auth.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { RenderWorkerHealth } from '../contracts/events.ts';
import type {
  MediaIngestJobName,
  MediaIngestPayloadMap,
  RenderExportJobName,
  RenderExportPayloadMap,
} from '../contracts/jobs.ts';
import type { StoragePort } from '../contracts/storage.ts';
import type { Database } from '../db/client.ts';
import type { AssetNamesService } from '../services/asset-names-service.ts';
import type { EventBusPort, HotTextCachePort, ProjectFilesService } from '../services/project-files-service.ts';
import type { VersionHistoryService } from '../services/version-history-service.ts';
import type { WorkRoundsService } from '../services/work-rounds-service.ts';
import type { WorkspaceService } from '../services/workspace-service.ts';
import type { ContainerFontCatalog } from './fonts-catalog.ts';

export interface StudioEventBusPort extends EventBusPort {
  subscribe(
    channel: string,
    listener: (payload: unknown, channel: string) => void,
  ): Promise<() => Promise<void>>;
  getRenderWorkersHealth(maxAgeMs?: number): Promise<RenderWorkerHealth[]>;
}

export interface StudioQueuesPort {
  enqueueMediaIngest<K extends MediaIngestJobName>(
    name: K,
    payload: MediaIngestPayloadMap[K],
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  enqueueRenderExport<K extends RenderExportJobName>(
    name: K,
    payload: RenderExportPayloadMap[K],
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface StudioVariables {
  auth: AuthContext;
  previewAssetBase?: string;
}

export interface DisklessStudioDeps {
  readonly db: Database;
  readonly storage: StoragePort;
  readonly hotTextCache?: HotTextCachePort;
  readonly eventBus?: StudioEventBusPort;
  readonly queues?: StudioQueuesPort;
  readonly workspace: WorkspaceService;
  readonly files: ProjectFilesService;
  readonly history: VersionHistoryService;
  readonly assetNames: AssetNamesService;
  readonly workRounds?: WorkRoundsService;
  readonly fontCatalog?: ContainerFontCatalog;
  readonly fontsDir?: string;
  readonly runtimeRoot?: string;
  readonly studioOrigin?: string;
  readonly resolveAuth?: (c: Context<{ Variables: StudioVariables }>) => AuthContext | Promise<AuthContext>;
  readonly skipDeterministicFonts?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly studioVersion?: string;
  readonly renderProgressKeepaliveMs?: number;
}

export async function getAuthContext(
  c: Context<{ Variables: StudioVariables }>,
  deps: DisklessStudioDeps,
  requirements?: { scope: PatScope; minRole?: WorkspaceRole },
): Promise<AuthContext> {
  const auth = deps.resolveAuth ? await deps.resolveAuth(c) : c.get('auth');
  if (!auth) {
    throw new CloudError('UNAUTHORIZED', 'Authentication context is required.', {
      status: 401,
      applied: false,
    });
  }
  if (requirements) {
    assertAuthAccess(auth, requirements);
  }
  return auth;
}

export function assertAuthAccess(
  auth: AuthContext,
  requirements: { scope: PatScope; minRole?: WorkspaceRole },
): void {
  if (requirements.minRole && !hasMinRole(auth, requirements.minRole)) {
    throw new CloudError(
      'FORBIDDEN',
      `Workspace role "${requirements.minRole}" or higher is required for this operation.`,
      {
        status: 403,
        applied: false,
        details: { requiredRole: requirements.minRole, role: auth.role },
      },
    );
  }
  if (!hasScope(auth, requirements.scope)) {
    throw new CloudError('INSUFFICIENT_SCOPE', `Scope "${requirements.scope}" is required for this operation.`, {
      status: 403,
      applied: false,
      details: { requiredScope: requirements.scope },
    });
  }
}

/** Legacy semantic HTTP routes remain available to authenticated API integrations. */
export async function getSemanticEditAuth(c: Context<{ Variables: StudioVariables }>, deps: DisklessStudioDeps) {
  const auth = await getAuthContext(c, deps, { scope: 'projects:write', minRole: 'editor' });
  requireProgrammaticEdit(auth);
  return auth;
}

/** Extract a wildcard path segment after `marker` (e.g. `"/files/"`), safely URI-decoded. */
export function extractWildcardPath(url: string, marker: string): string {
  const pathname = new URL(url).pathname;
  const idx = pathname.indexOf(marker);
  if (idx < 0) return '';
  const raw = pathname.slice(idx + marker.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new CloudError('INVALID_PATH', 'Malformed URL encoding in path.', { status: 400, applied: false });
  }
}

export function handleStudioError(c: Context, error: unknown): Response {
  if (isCloudError(error)) {
    return c.json(error.toJSON(), error.status as 400);
  }
  const message = error instanceof Error ? error.message : 'Internal studio error';
  return c.json({ code: 'INTERNAL_ERROR', error: message }, 500);
}

/** Older clients omit these headers and use the service's default file or command label. */
export function studioWriteHistory(headers: Headers, fallback?: string) {
  const encoded = headers.get('x-openmotion-edit-label');
  try {
    return { summary: encoded ? decodeURIComponent(encoded).trim().slice(0, 256) || fallback : fallback,
      windowId: headers.get('x-openmotion-edit-window') };
  } catch {
    throw new CloudError('INVALID_ARGUMENT', 'Malformed edit label', { status: 400, applied: false });
  }
}
