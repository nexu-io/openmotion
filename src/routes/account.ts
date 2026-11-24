import { Hono } from 'hono';
import { buildCloudIntegrationInfo } from '../../shared/integration.ts';
import { phase1Tools } from '../../shared/phase1-tools.ts';
import { isUuid } from '../../shared/project-validation.ts';
import { VERSION } from '../../shared/version.ts';
import { getAuthContext, type AuthEnv } from '../auth/middleware.ts';
import { buildOAuth21Config } from '../auth/oauth21.ts';
import { sessionCacheKey } from '../auth/session.ts';
import type { AuthKeyValueCache, AuthStore } from '../auth/store.ts';
import { isCloudError } from '../contracts/errors.ts';
import type { AppConfig } from '../infra/config.ts';
import { gatewayCallContextFromAuth, type PlatformModelGateway } from '../services/model-gateway.ts';

export interface AccountRoutesDeps {
  config: AppConfig;
  authStore: AuthStore;
  gateway: PlatformModelGateway;
  cache?: AuthKeyValueCache;
}

/**
 * Hono routes mounted at `/motion-api/account`.
 * Exposes cloud user identity, workspace switcher, OpenDesign billing/console link,
 * and Streamable HTTP `/mcp` integration metadata.
 */
export function createAccountRoutes(deps: AccountRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const consoleUrl = deps.config.OPENDESIGN_CONSOLE_URL;
  const oauthCfg = buildOAuth21Config(deps.config);

  app.get('/summary', async (c) => {
    try {
      const auth = getAuthContext(c);
      const refresh = c.req.query('refresh') === 'true';
      const gatewayCtx = gatewayCallContextFromAuth(auth, { signal: c.req.raw.signal });
      const [user, activeWorkspace, workspaces, billing, availableModels] = await Promise.all([
        deps.authStore.findUserById(auth.userId),
        deps.authStore.findWorkspaceById(auth.workspaceId),
        deps.authStore.listUserWorkspaces(auth.userId),
        deps.gateway.getBillingSummary
          ? deps.gateway.getBillingSummary(gatewayCtx)
          : Promise.resolve(null),
        deps.gateway.listMediaModels(gatewayCtx, { refresh }).catch(() => null),
      ]);

      return c.json({
        authenticated: true,
        authMode: auth.authMode,
        authMethod: auth.authMethod,
        consoleUrl,
        user: {
          id: auth.userId,
          email: user?.email ?? auth.email ?? null,
          displayName: user?.displayName ?? auth.displayName ?? 'User',
          avatarUrl: user?.avatarUrl ?? null,
          planTier: billing?.plan ?? user?.planTier ?? null,
        },
        activeWorkspace: activeWorkspace
          ? {
              id: activeWorkspace.id,
              slug: activeWorkspace.slug,
              name: activeWorkspace.name,
              role: auth.role,
              externalWorkspaceId: activeWorkspace.externalWorkspaceId,
            }
          : {
              id: auth.workspaceId,
              slug: 'workspace',
              name: 'Workspace',
              role: auth.role,
              externalWorkspaceId: auth.externalWorkspaceId ?? null,
            },
        workspaces,
        billing: billing ?? {
          plan: 'cloud',
          mediaEntitlement: 'unknown',
          unavailable: true,
        },
        modelGateway: {
          provider: deps.gateway.providerId,
          mode: deps.gateway.mode,
          ...(availableModels !== null ? { availableModelCount: availableModels.length } : {}),
        },
      });
    } catch (error) {
      if (isCloudError(error)) {
        return c.json(error.toJSON(), error.status as 400 | 401 | 403 | 404 | 500);
      }
      throw error;
    }
  });

  app.get('/workspaces', async (c) => {
    const auth = getAuthContext(c);
    const workspaces = await deps.authStore.listUserWorkspaces(auth.userId);
    return c.json({
      activeWorkspaceId: auth.workspaceId,
      workspaces,
    });
  });

  app.post('/workspaces/switch', async (c) => {
    const auth = getAuthContext(c);
    if (auth.authMethod !== 'session_cookie' || !auth.sessionId) {
      return c.json(
        {
          code: 'FORBIDDEN',
          error: 'Workspace switching requires an interactive browser cookie session.',
        },
        403,
      );
    }

    const body = (await c.req.json().catch(() => null)) as { workspaceId?: unknown } | null;
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
    if (!isUuid(workspaceId)) {
      return c.json({ code: 'INVALID_ARGUMENT', error: 'workspaceId must be a valid UUID' }, 400);
    }

    const membership = await deps.authStore.findMembership(workspaceId, auth.userId);
    if (!membership) {
      return c.json(
        { code: 'WORKSPACE_FORBIDDEN', error: 'You do not belong to the requested workspace.' },
        403,
      );
    }

    await deps.authStore.updateSessionWorkspace(auth.sessionId, workspaceId);
    const sessionTokenHash = c.get('sessionTokenHash');
    if (deps.cache && sessionTokenHash) {
      await deps.cache.del(sessionCacheKey(sessionTokenHash));
    }

    return c.json({
      ok: true,
      activeWorkspace: {
        id: membership.workspace.id,
        slug: membership.workspace.slug,
        name: membership.workspace.name,
        role: membership.role,
      },
    });
  });

  app.get('/integration', (c) => {
    const auth = getAuthContext(c);
    const info = buildCloudIntegrationInfo({
      publicOrigin: deps.config.APP_PUBLIC_ORIGIN,
      version: VERSION,
      workspaceId: auth.workspaceId,
      authMode: deps.config.AUTH_MODE,
      oauth2Enabled: true,
      patEnabled: true,
      authorizationServerUrl: oauthCfg.issuer,
      resourceMetadataUrl: oauthCfg.resourceMetadataUrl,
      tools: phase1Tools.map((tool) => ({ name: tool.name, description: tool.description })),
    });
    return c.json(info);
  });

  return app;
}
