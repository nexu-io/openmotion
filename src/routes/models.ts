import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { hasMinRole, hasScope, type AuthContext } from '../contracts/auth.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { AuthEnv } from '../auth/middleware.ts';
import { assertScope, getAuthContext } from '../auth/middleware.ts';
import type { AuthStore } from '../auth/store.ts';
import type { WorkspaceDefaultModels } from '../db/schema/auth.ts';
import {
  GatewayError,
  buildGatewayStatus,
  gatewayCallContextFromAuth,
  type PlatformModelGateway,
} from '../services/model-gateway.ts';

const VALID_DEFAULT_MODEL_REGEX = /^(?:opendesign:)?[a-zA-Z0-9][a-zA-Z0-9._/-]{0,179}$/;

export interface MediaJobPort {
  submitGeneration(auth: AuthContext, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  listJobs(auth: AuthContext, query: { projectId?: string; limit?: number; offset?: number }): Promise<Record<string, unknown>>;
  getJob(auth: AuthContext, jobId: string): Promise<Record<string, unknown>>;
  cancelJob(auth: AuthContext, jobId: string): Promise<Record<string, unknown>>;
  resumeJob(auth: AuthContext, jobId: string, requestId: string): Promise<Record<string, unknown>>;
}

export interface ModelRoutesDeps {
  gateway: PlatformModelGateway;
  authStore: AuthStore;
  mediaJobs?: MediaJobPort;
}

function handleRouteError(c: { json: (body: unknown, status?: 400 | 401 | 402 | 403 | 404 | 409 | 429 | 500 | 501 | 502 | 503) => Response }, error: unknown): Response {
  if (isCloudError(error)) {
    return c.json(error.toJSON(), error.status as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 501 | 502 | 503);
  }
  if (error instanceof GatewayError) {
    const status = (error.status && error.status >= 400 && error.status <= 503 ? error.status : 502) as 400 | 401 | 402 | 403 | 404 | 409 | 429 | 500 | 501 | 502 | 503;
    return c.json(
      {
        code: error.code,
        error: error.message,
        retryable: error.retryable,
        outcomeUnknown: error.outcomeUnknown,
      },
      status,
    );
  }
  throw error;
}

/**
 * Hono routes mounted at `/motion-api/models`.
 * Exposes the unified OpenDesign model catalogue, workspace default routing,
 * provider reference guide, and media job lifecycle (ZERO BYOK secret endpoints).
 */
export function createModelRoutes(deps: ModelRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  const loadWorkspaceDefaults = async (workspaceId: string): Promise<WorkspaceDefaultModels> => {
    const ws = await deps.authStore.findWorkspaceById(workspaceId);
    return ws?.defaultModels ?? {};
  };

  app.get('/', async (c) => {
    try {
      const auth = getAuthContext(c);
      assertScope(auth, 'assets:read');
      const refresh = c.req.query('refresh') === 'true';
      const modality = c.req.query('modality');
      const query = c.req.query('query')?.trim().toLowerCase() ?? '';

      const [models, defaults] = await Promise.all([
        deps.gateway.listMediaModels(
          gatewayCallContextFromAuth(auth, { signal: c.req.raw.signal }),
          { refresh },
        ),
        loadWorkspaceDefaults(auth.workspaceId),
      ]);

      const filtered = models.filter((m) => {
        if (modality && m.modality !== modality) return false;
        if (query && !m.id.toLowerCase().includes(query) && !m.label.toLowerCase().includes(query)) {
          return false;
        }
        return true;
      });

      return c.json({
        provider: deps.gateway.providerId,
        mode: deps.gateway.mode,
        defaults,
        models: filtered,
      });
    } catch (error) {
      return handleRouteError(c, error);
    }
  });

  app.get('/catalog', async (c) => {
    try {
      const auth = getAuthContext(c);
      assertScope(auth, 'assets:read');
      const refresh = c.req.query('refresh') === 'true';
      const [models, defaults] = await Promise.all([
        deps.gateway.listMediaModels(
          gatewayCallContextFromAuth(auth, { signal: c.req.raw.signal }),
          { refresh },
        ),
        loadWorkspaceDefaults(auth.workspaceId),
      ]);
      return c.json({
        provider: deps.gateway.providerId,
        mode: deps.gateway.mode,
        defaults,
        models,
      });
    } catch (error) {
      return handleRouteError(c, error);
    }
  });

  app.get('/status', async (c) => {
    try {
      const auth = getAuthContext(c);
      assertScope(auth, 'assets:read');
      const ctx = gatewayCallContextFromAuth(auth, { signal: c.req.raw.signal });
      const [models, defaults, billing] = await Promise.all([
        deps.gateway.listMediaModels(ctx),
        loadWorkspaceDefaults(auth.workspaceId),
        deps.gateway.getBillingSummary ? deps.gateway.getBillingSummary(ctx) : Promise.resolve(null),
      ]);
      // Strip raw balanceUsd from status overview; Studio Billing uses /motion-api/account/summary.
      const redactedBilling = billing
        ? {
            plan: billing.plan,
            mediaEntitlement: billing.mediaEntitlement,
            ...(billing.hasBalance !== undefined ? { hasBalance: billing.hasBalance } : {}),
            ...(billing.unavailable ? { unavailable: true } : {}),
          }
        : null;
      return c.json(buildGatewayStatus(models, defaults, redactedBilling, deps.gateway.statusIdentity));
    } catch (error) {
      return handleRouteError(c, error);
    }
  });

  app.get('/defaults', async (c) => {
    try {
      const auth = getAuthContext(c);
      assertScope(auth, 'assets:read');
      const defaults = await loadWorkspaceDefaults(auth.workspaceId);
      return c.json({ workspaceId: auth.workspaceId, defaults });
    } catch (error) {
      return handleRouteError(c, error);
    }
  });

  app.put('/defaults', async (c) => {
    try {
      const auth = getAuthContext(c);
      if (!hasMinRole(auth, 'admin') || !hasScope(auth, 'workspace:admin')) {
        throw new CloudError(
          'FORBIDDEN',
          'Managing workspace model defaults requires admin role and workspace:admin scope',
          { status: 403 },
        );
      }

      const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new CloudError('INVALID_ARGUMENT', 'Expected JSON object of modality defaults', {
          status: 400,
        });
      }

      const next: WorkspaceDefaultModels = {};
      for (const modality of ['image', 'video', 'audio'] as const) {
        const value = raw[modality];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string' || !VALID_DEFAULT_MODEL_REGEX.test(value)) {
          throw new CloudError('INVALID_ARGUMENT', `Invalid default model ID for ${modality}`, {
            status: 400,
          });
        }
        next[modality] = value;
      }

      const saved = await deps.authStore.updateWorkspaceDefaultModels(auth.workspaceId, next);
      return c.json({ workspaceId: auth.workspaceId, defaults: saved });
    } catch (error) {
      return handleRouteError(c, error);
    }
  });

  app.get('/providers/:provider/reference', async (c) => {
    try {
      const auth = getAuthContext(c);
      assertScope(auth, 'assets:read');
      const provider = c.req.param('provider');
      if (provider !== 'opendesign') {
        throw new CloudError(
          'NOT_FOUND',
          `Provider '${provider}' is not enabled in cloud deployment. Only the unified 'opendesign' platform gateway is active.`,
          { status: 404 },
        );
      }
      const guideUrl = new URL(
        '../../skills/openmotion-media/references/providers/opendesign.md',
        import.meta.url,
      );
      const content = await readFile(guideUrl, 'utf8');
      return c.json({
        provider: 'opendesign',
        uri: 'openmotion://workflow/media/opendesign',
        content,
      });
    } catch (error) {
      return handleRouteError(c, error);
    }
  });

  // Media job delegation routes (wired to worker-media job service in Wave 2C).
  app.post('/generate', async (c) => {
    try {
      const auth = getAuthContext(c);
      assertScope(auth, 'media:generate');
      if (!deps.mediaJobs) {
        throw new CloudError('SERVICE_UNAVAILABLE', 'Media generation job service is not wired', {
          status: 503,
        });
      }
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const result = await deps.mediaJobs.submitGeneration(auth, body);
      return c.json(result, 202);
    } catch (error) {
      return handleRouteError(c, error);
    }
  });

  app.get('/jobs', async (c) => {
    try {
      const auth = getAuthContext(c);
      assertScope(auth, 'assets:read');
      if (!deps.mediaJobs) {
        return c.json({ jobs: [], total: 0 });
      }
      const limitRaw = c.req.query('limit');
      const offsetRaw = c.req.query('offset');
      const result = await deps.mediaJobs.listJobs(auth, {
        projectId: c.req.query('projectId') || undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
        offset: offsetRaw ? Number(offsetRaw) : undefined,
      });
      return c.json(result);
    } catch (error) {
      return handleRouteError(c, error);
    }
  });

  app.get('/jobs/:jobId', async (c) => {
    try {
      const auth = getAuthContext(c);
      assertScope(auth, 'assets:read');
      if (!deps.mediaJobs) {
        throw new CloudError('NOT_FOUND', 'Media job not found', { status: 404 });
      }
      const result = await deps.mediaJobs.getJob(auth, c.req.param('jobId'));
      return c.json(result);
    } catch (error) {
      return handleRouteError(c, error);
    }
  });

  app.post('/jobs/:jobId/cancel', async (c) => {
    try {
      const auth = getAuthContext(c);
      assertScope(auth, 'media:generate');
      if (!deps.mediaJobs) {
        throw new CloudError('SERVICE_UNAVAILABLE', 'Media generation job service is not wired', {
          status: 503,
        });
      }
      const result = await deps.mediaJobs.cancelJob(auth, c.req.param('jobId'));
      return c.json(result);
    } catch (error) {
      return handleRouteError(c, error);
    }
  });

  app.post('/jobs/:jobId/resume', async (c) => {
    try {
      const auth = getAuthContext(c);
      assertScope(auth, 'media:generate');
      if (!deps.mediaJobs) {
        throw new CloudError('SERVICE_UNAVAILABLE', 'Media generation job service is not wired', {
          status: 503,
        });
      }
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const requestId = typeof body.requestId === 'string' ? body.requestId : '';
      if (!requestId) {
        throw new CloudError('INVALID_ARGUMENT', 'requestId is required to resume a media job', {
          status: 400,
        });
      }
      const result = await deps.mediaJobs.resumeJob(auth, c.req.param('jobId'), requestId);
      return c.json(result);
    } catch (error) {
      return handleRouteError(c, error);
    }
  });

  return app;
}
