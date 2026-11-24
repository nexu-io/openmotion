import { randomUUID } from 'node:crypto';
import {
  normalizeDesktopHandoffPlanTier,
  type DesktopHandoffPlanTier,
} from '../../shared/desktop-auth-handoff.ts';
import {
  type AmrWorkspaceRole,
  type AuthContext,
  type EffectiveWriteAccess,
  type PatScope,
  type WorkspaceRole,
} from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { AppConfig } from '../infra/config.ts';
import { createLogger, type Logger } from '../infra/logger.ts';
import {
  intersectScopesWithRole,
  roleAllowedScopes,
  type AuthKeyValueCache,
  type AuthStore,
  type MembershipResolution,
} from './store.ts';

export const MAX_AMR_IDENTITY_CACHE_TTL_SEC = 60;

export type OneTapPlanTier = DesktopHandoffPlanTier;

export interface AmrOneTapChallengeRequest {
  readonly expectedOrigin: string;
  readonly surface: 'motion_web';
  readonly attemptId: string;
  readonly browserBindingHash: string;
}

export interface AmrOneTapChallengeResponse {
  readonly challengeId: string;
  readonly nonce: string;
  readonly clientId: string;
  readonly expiresAt: string;
}

export interface AmrOneTapAttribution {
  readonly utmSource?: string;
  readonly utmMedium?: string;
  readonly utmCampaign?: string;
  readonly utmContent?: string;
  readonly utmTerm?: string;
  readonly landingPath?: string;
  readonly odEntry?: Record<string, unknown>;
}

export interface AmrOneTapExchangeRequest {
  readonly challengeId: string;
  readonly idToken: string;
  readonly expectedOrigin: string;
  readonly surface: 'motion_web';
  readonly browserBindingHash: string;
  readonly attribution?: AmrOneTapAttribution;
  readonly referralCode?: string;
}

export interface AmrOneTapExchangeResponse {
  readonly ok: true;
  readonly authUserId: string;
  readonly appUserId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly image: string | null;
  readonly isNewUser: boolean;
  readonly planTier: OneTapPlanTier;
}

export interface AmrOneTapHandoffTicketRequest {
  readonly authUserId: string;
  readonly appUserId: string;
  readonly targetPath?: string;
}

export interface AmrOneTapHandoffTicketResponse {
  readonly ticket: string;
  readonly handoffUrl: string;
  readonly expiresAt: string;
}

export class AmrOneTapError extends Error {
  readonly status: 400 | 403 | 409 | 503;
  readonly code: string;

  constructor(status: 400 | 403 | 409 | 503, code: string, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'AmrOneTapError';
    this.status = status;
    this.code = code;
  }

  toJSON(): { code: string; error: string; message: string } {
    return {
      code: this.code,
      error: this.message,
      message: this.message,
    };
  }
}

export function isAmrOneTapError(error: unknown): error is AmrOneTapError {
  return error instanceof AmrOneTapError;
}

type LookupFailureReason = 'timeout' | 'transport' | 'upstream_http' | 'invalid_response' | 'missing_workspace';

export interface AmrWorkspaceSnapshot {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceType: 'personal' | 'team';
  readonly workspaceMemberId: string;
  readonly role: AmrWorkspaceRole;
  readonly lifecycleState: string;
  readonly effectiveWriteAccess: EffectiveWriteAccess;
}

export interface AmrWorkspaceDirectoryEntry {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceType: 'personal' | 'team';
  readonly role: AmrWorkspaceRole;
  readonly lifecycleState: string;
}

export interface AmrIdentityLookupResponse {
  readonly active: boolean;
  readonly status: string;
  readonly accessRevokedAt?: string | null;
  readonly authUserId: string;
  readonly appUserId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly image: string | null;
  readonly workspace: AmrWorkspaceSnapshot | null;
  readonly workspaces?: readonly AmrWorkspaceDirectoryEntry[];
}

export type AmrIdentityLookupResult =
  | { readonly kind: 'ok'; readonly data: AmrIdentityLookupResponse }
  | { readonly kind: 'inactive'; readonly status: string }
  | { readonly kind: 'user_not_found' }
  | { readonly kind: 'workspace_not_found'; readonly code?: string };

export function mapAmrRoleToMotionRole(role: AmrWorkspaceRole): WorkspaceRole {
  switch (role) {
    case 'owner':
      return 'owner';
    case 'admin':
      return 'admin';
    case 'member':
      return 'editor';
  }
}

export function amrIdentityCacheKey(authUserId: string, externalWorkspaceId?: string | null): string {
  const wsPart = externalWorkspaceId?.trim() || 'default';
  return `om:amr:id:${authUserId}:${wsPart}`;
}

export interface AmrIdentityClientOptions {
  apiUrl: string;
  internalToken: string;
  /** Dedicated internal-only AMR base URL for One Tap S2S endpoints (required for One Tap; never falls back to apiUrl). */
  oneTapApiUrl?: string;
  /** Dedicated internal service token for One Tap S2S endpoints (required for One Tap; never falls back to internalToken). */
  oneTapInternalToken?: string;
  cache?: AuthKeyValueCache;
  cacheTtlSec?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  logger?: Pick<Logger, 'warn'>;
}

export function amrIdentityClientFromAppConfig(
  config: Pick<
    AppConfig,
    | 'OPENDESIGN_API_URL'
    | 'OPENDESIGN_INTERNAL_API_TOKEN'
    | 'OPENDESIGN_S2S_API_KEY'
    | 'OPENDESIGN_ONE_TAP_INTERNAL_URL'
    | 'OPENDESIGN_ONE_TAP_INTERNAL_TOKEN'
    | 'AMR_IDENTITY_CACHE_TTL_SEC'
  >,
  cache?: AuthKeyValueCache,
  logger?: Pick<Logger, 'warn'>,
): AmrIdentityClient | undefined {
  const token = config.OPENDESIGN_INTERNAL_API_TOKEN ?? config.OPENDESIGN_S2S_API_KEY;
  if (!token) return undefined;
  return new AmrIdentityClient({
    apiUrl: config.OPENDESIGN_API_URL,
    internalToken: token,
    oneTapApiUrl: config.OPENDESIGN_ONE_TAP_INTERNAL_URL,
    oneTapInternalToken: config.OPENDESIGN_ONE_TAP_INTERNAL_TOKEN,
    cache,
    logger,
    cacheTtlSec: config.AMR_IDENTITY_CACHE_TTL_SEC,
  });
}

/**
 * Service-to-service identity lookup client against AMR (`GET /api/internal/identity/:authUserId`).
 * Enforces:
 * - x-internal-token auth ONLY (never Authorization: Bearer)
 * - Cache key isolated by (authUserId, externalWorkspaceId) with TTL <= 60s
 * - 503 AUTH_UNAVAILABLE on AMR unreachability (never silently accepts or clears session)
 * - 401 UNAUTHORIZED (auth_required) on banned/deleting/deleted/revoked accounts
 */
export class AmrIdentityClient {
  private readonly apiUrl: string;
  private readonly internalToken: string;
  private readonly oneTapApiUrl: string | undefined;
  private readonly oneTapInternalToken: string | undefined;
  private readonly cache?: AuthKeyValueCache;
  private readonly cacheTtlSec: number;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  private readonly logger: Pick<Logger, 'warn'>;

  constructor(options: AmrIdentityClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.internalToken = options.internalToken;
    const rawOneTapUrl = options.oneTapApiUrl?.trim();
    const rawOneTapToken = options.oneTapInternalToken?.trim();
    this.oneTapApiUrl = rawOneTapUrl ? rawOneTapUrl.replace(/\/$/, '') : undefined;
    this.oneTapInternalToken = rawOneTapToken || undefined;
    this.cache = options.cache;
    this.cacheTtlSec = Math.min(
      MAX_AMR_IDENTITY_CACHE_TTL_SEC,
      Math.max(1, Math.floor(options.cacheTtlSec ?? MAX_AMR_IDENTITY_CACHE_TTL_SEC)),
    );
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetcher = options.fetcher ?? fetch;
    this.logger = options.logger ?? createLogger();
  }

  isOneTapConfigured(): boolean {
    return Boolean(this.oneTapApiUrl && this.oneTapInternalToken);
  }

  private unavailable(
    reason: LookupFailureReason,
    message: string,
    context: { upstreamStatus?: number; cause?: unknown },
  ): CloudError {
    const diagnosticId = randomUUID();
    this.logger.warn('AMR identity lookup unavailable', {
      diagnosticId,
      reason,
      upstreamStatus: context.upstreamStatus,
    });
    return new CloudError('AUTH_UNAVAILABLE', message, { status: 503, details: { diagnosticId }, cause: context.cause });
  }

  async lookupIdentity(
    authUserId: string,
    options: { externalWorkspaceId?: string | null; bypassCache?: boolean } = {},
  ): Promise<AmrIdentityLookupResult> {
    const cacheKey = amrIdentityCacheKey(authUserId, options.externalWorkspaceId);

    if (this.cache && !options.bypassCache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as AmrIdentityLookupResponse;
          if (parsed && parsed.active === true && parsed.workspace) {
            return { kind: 'ok', data: parsed };
          }
        } catch {
          await this.cache.del(cacheKey);
        }
      }
    }

    const url = new URL(`${this.apiUrl}/api/internal/identity/${encodeURIComponent(authUserId)}`);
    if (options.externalWorkspaceId) {
      url.searchParams.set('workspaceId', options.externalWorkspaceId);
    }

    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method: 'GET',
        headers: {
          'x-internal-token': this.internalToken,
          Accept: 'application/json',
        },
        signal,
      });
    } catch (cause) {
      throw this.unavailable(
        signal.aborted ? 'timeout' : 'transport',
        'Temporarily unable to verify login state with OpenDesign account service.',
        { cause },
      );
    }

    if (response.status >= 500 || response.status === 429) {
      throw this.unavailable(
        'upstream_http',
        `OpenDesign account identity lookup failed with HTTP ${response.status}.`,
        { upstreamStatus: response.status },
      );
    }

    const rawBody = (await response.json().catch(() => null)) as Record<string, unknown> | null;

    if (response.status === 404) {
      const errCode = typeof rawBody?.error === 'string' ? rawBody.error : '';
      if (errCode === 'workspace_not_found') {
        return {
          kind: 'workspace_not_found',
          code: typeof rawBody?.code === 'string' ? rawBody.code : undefined,
        };
      }
      return { kind: 'user_not_found' };
    }

    if (!response.ok || !rawBody) {
      throw this.unavailable(
        !response.ok ? 'upstream_http' : signal.aborted ? 'timeout' : 'invalid_response',
        `Unexpected identity service response HTTP ${response.status}.`,
        { upstreamStatus: response.status },
      );
    }

    if (rawBody.active !== true) {
      return {
        kind: 'inactive',
        status: typeof rawBody.status === 'string' ? rawBody.status : 'inactive',
      };
    }

    const ws = rawBody.workspace as AmrWorkspaceSnapshot | null | undefined;
    if (!ws || typeof ws.workspaceId !== 'string' || typeof ws.workspaceMemberId !== 'string') {
      throw this.unavailable('missing_workspace', 'AMR identity response missing workspace context.', {
        upstreamStatus: response.status,
      });
    }

    const data: AmrIdentityLookupResponse = {
      active: true,
      status: String(rawBody.status ?? 'active'),
      authUserId: String(rawBody.authUserId ?? authUserId),
      appUserId: String(rawBody.appUserId ?? ''),
      email: typeof rawBody.email === 'string' ? rawBody.email : null,
      name: typeof rawBody.name === 'string' ? rawBody.name : null,
      image: typeof rawBody.image === 'string' ? rawBody.image : null,
      workspace: ws,
      workspaces: Array.isArray(rawBody.workspaces)
        ? (rawBody.workspaces as AmrWorkspaceDirectoryEntry[])
        : undefined,
    };

    if (this.cache) {
      await this.cache.set(cacheKey, JSON.stringify(data), this.cacheTtlSec);
    }

    return { kind: 'ok', data };
  }

  /**
   * Resolves AMR identity during OIDC callback and projects user + AMR workspace into Motion DB.
   */
  async resolveAndProjectLogin(
    store: AuthStore,
    input: {
      authUserId: string;
      email?: string | null;
      displayName: string;
      avatarUrl?: string | null;
      requestedExternalWorkspaceId?: string | null;
    },
  ): Promise<{ membership: MembershipResolution; identity: AmrIdentityLookupResponse }> {
    const lookup = await this.lookupIdentity(input.authUserId, {
      externalWorkspaceId: input.requestedExternalWorkspaceId,
      bypassCache: true,
    });

    if (lookup.kind === 'inactive' || lookup.kind === 'user_not_found') {
      throw new CloudError('UNAUTHORIZED', 'Account is not active or does not exist.', {
        status: 401,
      });
    }
    if (lookup.kind === 'workspace_not_found') {
      throw new CloudError('WORKSPACE_FORBIDDEN', 'No active workspace membership found.', {
        status: 403,
      });
    }

    const ws = lookup.data.workspace!;
    const mappedRole = mapAmrRoleToMotionRole(ws.role);
    const membership = await store.projectAmrUserAndWorkspace({
      oidcSub: lookup.data.authUserId,
      appUserId: lookup.data.appUserId,
      email: lookup.data.email ?? input.email ?? null,
      displayName: lookup.data.name || input.displayName,
      avatarUrl: lookup.data.image ?? input.avatarUrl ?? null,
      externalWorkspaceId: ws.workspaceId,
      workspaceName: ws.workspaceName,
      role: mappedRole,
    });

    // Also project any additional AMR workspaces returned in the directory so UI switchers have local IDs.
    if (lookup.data.workspaces) {
      for (const entry of lookup.data.workspaces) {
        if (entry.workspaceId === ws.workspaceId) continue;
        await store
          .projectAmrUserAndWorkspace({
            oidcSub: lookup.data.authUserId,
            appUserId: lookup.data.appUserId,
            email: lookup.data.email ?? input.email ?? null,
            displayName: lookup.data.name || input.displayName,
            avatarUrl: lookup.data.image ?? input.avatarUrl ?? null,
            externalWorkspaceId: entry.workspaceId,
            workspaceName: entry.workspaceName,
            role: mapAmrRoleToMotionRole(entry.role),
          })
          .catch(() => {});
      }
    }

    return { membership, identity: lookup.data };
  }

  /**
   * Verifies a locally authenticated AuthContext against AMR live account status & workspace membership
   * (using the 60s cache keyed by authUserId + externalWorkspaceId) and recalculates scopes on every call.
   */
  async verifyAndEnrichAuthContext(
    store: AuthStore,
    localAuth: AuthContext,
    options: { requestedExternalWorkspaceId?: string | null; bypassCache?: boolean } = {},
  ): Promise<AuthContext> {
    const user = await store.findUserById(localAuth.userId);
    const authUserId = localAuth.authUserId ?? user?.oidcSub;
    if (!authUserId) {
      throw new CloudError('UNAUTHORIZED', 'Unable to resolve upstream user identity.', {
        status: 401,
      });
    }

    const externalWorkspaceId =
      options.requestedExternalWorkspaceId ?? localAuth.externalWorkspaceId ?? null;

    const lookup = await this.lookupIdentity(authUserId, {
      externalWorkspaceId,
      bypassCache: options.bypassCache,
    });

    if (lookup.kind === 'inactive' || lookup.kind === 'user_not_found') {
      throw new CloudError('UNAUTHORIZED', 'Account is suspended, deleted, or revoked.', {
        status: 401,
      });
    }
    if (lookup.kind === 'workspace_not_found') {
      throw new CloudError(
        'PROJECT_NOT_FOUND',
        'Workspace not found or user is no longer an active member.',
        { status: 404 },
      );
    }

    const ws = lookup.data.workspace!;
    const mappedRole = mapAmrRoleToMotionRole(ws.role);

    // Ensure local workspace projection exists and matches the AMR workspace.
    let workspaceId = localAuth.workspaceId;
    if (localAuth.externalWorkspaceId !== ws.workspaceId) {
      const projected = await store.projectAmrUserAndWorkspace({
        oidcSub: lookup.data.authUserId,
        appUserId: lookup.data.appUserId,
        email: lookup.data.email ?? localAuth.email ?? null,
        displayName: lookup.data.name || localAuth.displayName || 'User',
        avatarUrl: lookup.data.image ?? localAuth.avatarUrl ?? null,
        externalWorkspaceId: ws.workspaceId,
        workspaceName: ws.workspaceName,
        role: mappedRole,
      });
      workspaceId = projected.workspace.id;
    }

    // Recompute scopes on EVERY request (even on cache hit!):
    // browser sessions get full role scopes; tokens strictly intersect with live AMR role ceiling.
    const effectiveScopes: PatScope[] =
      localAuth.authMethod === 'session_cookie'
        ? [...roleAllowedScopes(mappedRole)]
        : intersectScopesWithRole(localAuth.scopes, mappedRole);

    return {
      ...localAuth,
      workspaceId,
      role: mappedRole,
      scopes: effectiveScopes,
      authUserId: lookup.data.authUserId,
      appUserId: lookup.data.appUserId,
      externalWorkspaceId: ws.workspaceId,
      amrWorkspaceMemberId: ws.workspaceMemberId,
      amrWorkspaceRole: ws.role,
      amrWorkspaceLifecycleState: ws.lifecycleState,
      effectiveWriteAccess: ws.effectiveWriteAccess,
      email: lookup.data.email ?? localAuth.email ?? null,
      displayName: lookup.data.name ?? localAuth.displayName,
      avatarUrl: lookup.data.image ?? localAuth.avatarUrl ?? null,
    };
  }

  private async postOneTapJson(
    path: string,
    payload: unknown,
    actionLabel: string,
  ): Promise<Record<string, unknown>> {
    if (!this.oneTapApiUrl || !this.oneTapInternalToken) {
      throw new AmrOneTapError(
        503,
        'ONE_TAP_UNAVAILABLE',
        'Dedicated internal One Tap service URL and token are required.',
      );
    }
    const url = `${this.oneTapApiUrl}${path}`;
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          'x-internal-token': this.oneTapInternalToken,
          'content-type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (cause) {
      const diagnosticId = randomUUID();
      this.logger.warn(`AMR ${actionLabel} unavailable`, {
        diagnosticId,
        reason: signal.aborted ? 'timeout' : 'transport',
      });
      throw new AmrOneTapError(
        503,
        'AUTH_UNAVAILABLE',
        'Temporarily unable to reach OpenDesign authentication service.',
        cause,
      );
    }

    const rawBody = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const rawCode = typeof rawBody?.code === 'string' && rawBody.code.trim() ? rawBody.code.trim() : null;
    const rawMessage =
      (typeof rawBody?.message === 'string' && rawBody.message.trim()
        ? rawBody.message.trim()
        : typeof rawBody?.error === 'string' && rawBody.error.trim()
          ? rawBody.error.trim()
          : null) ?? `OpenDesign authentication service failed with HTTP ${response.status}.`;

    if (response.status === 400 || response.status === 403 || response.status === 409) {
      const fallbackCode =
        response.status === 400
          ? 'INVALID_ID_TOKEN'
          : response.status === 403
            ? 'FORBIDDEN'
            : 'LINK_CONFIRM_REQUIRED';
      throw new AmrOneTapError(response.status, rawCode ?? fallbackCode, rawMessage);
    }

    if (response.status === 503) {
      const code = rawCode === 'ONE_TAP_UNAVAILABLE' ? 'ONE_TAP_UNAVAILABLE' : 'AUTH_UNAVAILABLE';
      throw new AmrOneTapError(503, code, rawMessage);
    }

    if (!response.ok || !rawBody) {
      const diagnosticId = randomUUID();
      this.logger.warn(`AMR ${actionLabel} failed`, {
        diagnosticId,
        upstreamStatus: response.status,
      });
      throw new AmrOneTapError(503, 'AUTH_UNAVAILABLE', rawMessage);
    }

    return rawBody;
  }

  async requestOneTapChallenge(input: AmrOneTapChallengeRequest): Promise<AmrOneTapChallengeResponse> {
    const raw = await this.postOneTapJson(
      '/api/internal/auth/one-tap/challenge',
      {
        expectedOrigin: input.expectedOrigin,
        surface: input.surface,
        attemptId: input.attemptId,
        browserBindingHash: input.browserBindingHash,
      },
      'one-tap challenge',
    );

    const challengeId = typeof raw.challengeId === 'string' ? raw.challengeId.trim() : '';
    const nonce = typeof raw.nonce === 'string' ? raw.nonce.trim() : '';
    const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : '';
    const expiresAt = typeof raw.expiresAt === 'string' ? raw.expiresAt.trim() : '';
    if (!challengeId || !nonce || !clientId || !expiresAt) {
      throw new AmrOneTapError(
        503,
        'ONE_TAP_UNAVAILABLE',
        'Invalid challenge response from OpenDesign authentication service.',
      );
    }
    return { challengeId, nonce, clientId, expiresAt };
  }

  async exchangeOneTapCredential(input: AmrOneTapExchangeRequest): Promise<AmrOneTapExchangeResponse> {
    const raw = await this.postOneTapJson(
      '/api/internal/auth/one-tap/exchange',
      {
        challengeId: input.challengeId,
        idToken: input.idToken,
        expectedOrigin: input.expectedOrigin,
        surface: input.surface,
        browserBindingHash: input.browserBindingHash,
        ...(input.attribution ? { attribution: input.attribution } : {}),
        ...(input.referralCode ? { referralCode: input.referralCode } : {}),
      },
      'one-tap exchange',
    );

    const authUserId = typeof raw.authUserId === 'string' ? raw.authUserId.trim() : '';
    const appUserId = typeof raw.appUserId === 'string' ? raw.appUserId.trim() : '';
    if (raw.ok === false || !authUserId || !appUserId) {
      throw new AmrOneTapError(
        503,
        'AUTH_UNAVAILABLE',
        'Invalid credential exchange response from OpenDesign authentication service.',
      );
    }

    return {
      ok: true,
      authUserId,
      appUserId,
      email: typeof raw.email === 'string' ? raw.email : null,
      name: typeof raw.name === 'string' ? raw.name : null,
      image: typeof raw.image === 'string' ? raw.image : null,
      isNewUser: Boolean(raw.isNewUser),
      planTier: normalizeDesktopHandoffPlanTier(raw.planTier),
    };
  }

  async createOneTapHandoffTicket(
    input: AmrOneTapHandoffTicketRequest,
  ): Promise<AmrOneTapHandoffTicketResponse> {
    const raw = await this.postOneTapJson(
      '/api/internal/auth/one-tap/handoff-ticket',
      {
        authUserId: input.authUserId,
        appUserId: input.appUserId,
        ...(input.targetPath ? { targetPath: input.targetPath } : {}),
      },
      'one-tap handoff ticket',
    );

    const ticket = typeof raw.ticket === 'string' ? raw.ticket.trim() : '';
    const handoffUrl = typeof raw.handoffUrl === 'string' ? raw.handoffUrl.trim() : '';
    const expiresAt = typeof raw.expiresAt === 'string' ? raw.expiresAt.trim() : '';
    if (!ticket || !handoffUrl || !expiresAt) {
      throw new AmrOneTapError(
        503,
        'AUTH_UNAVAILABLE',
        'Invalid handoff ticket response from OpenDesign authentication service.',
      );
    }
    return { ticket, handoffUrl, expiresAt };
  }

  async lookupBillingPlanTier(appUserId: string): Promise<OneTapPlanTier> {
    const trimmed = appUserId.trim();
    if (!trimmed) return 'unknown';

    const url = `${this.apiUrl}/api/internal/billing/summary/${encodeURIComponent(trimmed)}`;
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'GET',
        headers: {
          'x-internal-token': this.internalToken,
          Accept: 'application/json',
        },
        signal,
      });
    } catch {
      this.logger.warn('AMR billing plan tier lookup failed', {
        reason: signal.aborted ? 'timeout' : 'transport',
      });
      return 'unknown';
    }

    if (!response.ok) {
      this.logger.warn('AMR billing plan tier lookup returned non-2xx', {
        upstreamStatus: response.status,
      });
      return 'unknown';
    }

    const rawBody = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!rawBody) return 'unknown';

    // Authoritative AMR billing summary uses `membershipTier: null` when a user has no paid subscription (Free tier).
    const rawTier = rawBody.membershipTier ?? rawBody.planTier ?? rawBody.plan;
    if (
      rawTier === undefined &&
      Object.hasOwn(rawBody, 'membershipTier') &&
      rawBody.membershipTier === null
    ) {
      return 'free';
    }
    return normalizeDesktopHandoffPlanTier(rawTier);
  }
}
