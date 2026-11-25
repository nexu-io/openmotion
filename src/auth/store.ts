import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import {
  DEFAULT_PAT_SCOPES,
  PAT_SCOPES,
  type PatScope,
  type WorkspaceRole,
} from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { Database } from '../db/client.ts';
import { asInsert, asUpdate } from '../db/helpers.ts';
import {
  authSessions,
  oauthAuthorizationCodes,
  oauthClients,
  oauthTokens,
  personalAccessTokens,
  users,
  workspaceMembers,
  workspaces,
  type WorkspaceDefaultModels,
} from '../db/schema/auth.ts';
import { projectGrants } from '../db/schema/projects.ts';

// ---------------------------------------------------------------------------
// Crypto & Scope Primitives
// ---------------------------------------------------------------------------

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

export function randomBase64Url(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

export function randomHex(byteLength = 4): string {
  return randomBytes(byteLength).toString('hex');
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.byteLength !== bufB.byteLength) return false;
  return timingSafeEqual(bufA, bufB);
}

const VIEWER_SCOPES: readonly PatScope[] = ['projects:read', 'assets:read', 'mcp:tools'] as const;

/**
 * Maximum scopes permitted for a workspace role.
 * Never used to elevate a restricted PAT — only to cap effective permissions
 * when a token is minted or evaluated against live workspace membership.
 */
export function roleAllowedScopes(role: WorkspaceRole): readonly PatScope[] {
  switch (role) {
    case 'owner':
    case 'admin':
      return PAT_SCOPES;
    case 'editor':
      return DEFAULT_PAT_SCOPES;
    case 'viewer':
      return VIEWER_SCOPES;
  }
}

export function isValidPatScope(value: string): value is PatScope {
  return (PAT_SCOPES as readonly string[]).includes(value);
}

/**
 * Strictly intersects token/requested scopes with the caller's live workspace role ceiling.
 * A restricted PAT owned by an `owner` with `['projects:read']` stays strictly `['projects:read']`.
 */
export function intersectScopesWithRole(
  tokenScopes: readonly PatScope[],
  role: WorkspaceRole,
): PatScope[] {
  const allowed = new Set<PatScope>(roleAllowedScopes(role));
  const out: PatScope[] = [];
  const seen = new Set<PatScope>();
  for (const scope of tokenScopes) {
    if (allowed.has(scope) && !seen.has(scope)) {
      seen.add(scope);
      out.push(scope);
    }
  }
  return out;
}

export function assertSafeReturnTo(raw: string | undefined | null): string {
  if (!raw) return '/';
  const trimmed = raw.trim();
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    /[\x00-\x1f]/.test(trimmed)
  ) {
    return '/';
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Store Record Types
// ---------------------------------------------------------------------------

export interface UserRecord {
  id: string;
  oidcSub: string;
  appUserId?: string | null;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  planTier: string | null;
}

export interface WorkspaceRecord {
  id: string;
  slug: string;
  externalWorkspaceId: string | null;
  name: string;
  ownerUserId: string;
  defaultModels: WorkspaceDefaultModels;
}

export interface UserWorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  role: WorkspaceRole;
  externalWorkspaceId: string | null;
}

export interface MembershipResolution {
  user: UserRecord;
  workspace: WorkspaceRecord;
  role: WorkspaceRole;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  workspaceId: string;
  tokenHash: string;
  csrfTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface PatRecord {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  tokenHash: string;
  scopes: PatScope[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export type OAuthAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface OAuthClientRecord {
  clientId: string;
  clientSecretHash: string | null;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: OAuthAuthMethod;
  createdAt: Date;
}

export interface OAuthAuthCodeRecord {
  codeHash: string;
  clientId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  resource: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface OAuthTokenRecord {
  id: string;
  clientId: string;
  userId: string;
  workspaceId: string;
  accessTokenHash: string;
  refreshTokenHash: string | null;
  scope: string;
  resource: string | null;
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
  lastUsedAt?: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface ConnectedAppSummary {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  workspaceId: string;
  scopes: string[];
  firstAuthorizedAt: Date;
  lastUsedAt: Date | null;
  activeTokenCount: number;
}

export interface ProjectGrantRecord {
  id: string;
  projectId: string;
  userId: string;
  workspaceId: string;
  clientId: string;
  grantedAt: Date;
  revokedAt: Date | null;
}

export interface AuthStore {
  // Users & workspaces
  findUserById(userId: string): Promise<UserRecord | null>;
  findUserByOidcSub(oidcSub: string): Promise<UserRecord | null>;
  upsertOidcUserAndWorkspace(input: {
    oidcSub: string;
    email?: string | null;
    displayName: string;
    avatarUrl?: string | null;
    externalWorkspaceId?: string | null;
  }): Promise<MembershipResolution>;
  projectAmrUserAndWorkspace(input: {
    oidcSub: string;
    appUserId: string;
    email?: string | null;
    displayName: string;
    avatarUrl?: string | null;
    externalWorkspaceId: string;
    workspaceName: string;
    role: WorkspaceRole;
  }): Promise<MembershipResolution>;
  findWorkspaceByExternalId(externalWorkspaceId: string): Promise<WorkspaceRecord | null>;
  ensureDevTenant(input: {
    workspaceId: string;
    userId: string;
    email?: string;
    displayName?: string;
  }): Promise<MembershipResolution>;
  listUserWorkspaces(userId: string): Promise<UserWorkspaceSummary[]>;
  findMembership(workspaceId: string, userId: string): Promise<MembershipResolution | null>;
  findWorkspaceById(workspaceId: string): Promise<WorkspaceRecord | null>;
  updateWorkspaceDefaultModels(
    workspaceId: string,
    defaultModels: WorkspaceDefaultModels,
  ): Promise<WorkspaceDefaultModels>;

  // Browser sessions (PG authoritative)
  createSession(input: {
    userId: string;
    workspaceId: string;
    tokenHash: string;
    csrfTokenHash: string;
    expiresAt: Date;
  }): Promise<AuthSessionRecord>;
  findActiveSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>;
  touchSession(sessionId: string): Promise<void>;
  updateSessionWorkspace(sessionId: string, workspaceId: string): Promise<boolean>;
  revokeSessionById(sessionId: string): Promise<boolean>;
  revokeSessionByTokenHash(tokenHash: string): Promise<boolean>;

  // Personal Access Tokens
  createPat(input: {
    workspaceId: string;
    userId: string;
    name: string;
    tokenPrefix: string;
    tokenHash: string;
    scopes: PatScope[];
    expiresAt: Date | null;
  }): Promise<PatRecord>;
  findActivePatByHash(tokenHash: string): Promise<PatRecord | null>;
  listPats(workspaceId: string, userId?: string): Promise<PatRecord[]>;
  touchPat(tokenId: string): Promise<void>;
  revokePat(workspaceId: string, tokenId: string, userId?: string): Promise<boolean>;

  // OAuth 2.1
  createOAuthClient(input: {
    clientId: string;
    clientSecretHash: string | null;
    clientName: string;
    redirectUris: string[];
    grantTypes: string[];
    tokenEndpointAuthMethod: OAuthAuthMethod;
  }): Promise<OAuthClientRecord>;
  findOAuthClient(clientId: string): Promise<OAuthClientRecord | null>;
  createOAuthAuthCode(input: {
    codeHash: string;
    clientId: string;
    userId: string;
    workspaceId: string;
    redirectUri: string;
    scope: string;
    codeChallenge: string;
    resource: string | null;
    expiresAt: Date;
  }): Promise<OAuthAuthCodeRecord>;
  consumeOAuthAuthCode(codeHash: string): Promise<OAuthAuthCodeRecord | null>;
  createOAuthToken(input: {
    clientId: string;
    userId: string;
    workspaceId: string;
    accessTokenHash: string;
    refreshTokenHash: string | null;
    scope: string;
    resource: string | null;
    accessExpiresAt: Date;
    refreshExpiresAt: Date | null;
  }): Promise<OAuthTokenRecord>;
  findActiveOAuthTokenByAccessHash(accessTokenHash: string): Promise<OAuthTokenRecord | null>;
  findActiveOAuthTokenByRefreshHash(refreshTokenHash: string): Promise<OAuthTokenRecord | null>;
  /** Any row (including revoked/expired) for refresh-token reuse detection. */
  findOAuthTokenByRefreshHash(refreshTokenHash: string): Promise<OAuthTokenRecord | null>;
  touchOAuthToken(tokenId: string): Promise<void>;
  /** Rotation only: keeps the refresh hash so a later replay is detected as reuse. */
  revokeOAuthTokenById(tokenId: string): Promise<boolean>;
  /**
   * Explicit revocations (RFC 7009, disconnect) also clear the refresh hash, so only tokens retired
   * by rotation can trigger reuse detection.
   */
  revokeOAuthTokenByHash(hash: string): Promise<boolean>;
  listConnectedApps(userId: string): Promise<ConnectedAppSummary[]>;
  /** Explicit revocation of every live token of a connection; clears refresh hashes the same way. */
  revokeOAuthClientForUser(userId: string, clientId: string): Promise<number>;
  cleanupUnusedOAuthClients(olderThan: Date): Promise<number>;

  // Project-level agent grants
  grantProjectAccess(input: {
    projectId: string;
    userId: string;
    workspaceId: string;
    clientId: string;
  }): Promise<ProjectGrantRecord>;
  revokeProjectAccess(input: {
    projectId: string;
    userId: string;
    clientId: string;
  }): Promise<boolean>;
  hasActiveProjectGrant(input: {
    projectId: string;
    userId: string;
    clientId: string;
  }): Promise<boolean>;
  listProjectGrants(projectId: string, userId: string): Promise<ProjectGrantRecord[]>;
}

// ---------------------------------------------------------------------------
// Key-Value Cache Seam (Redis or in-memory fallback)
// ---------------------------------------------------------------------------

export interface AuthKeyValueCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomically read and delete a key (e.g. Redis GETDEL) for single-use tokens. */
  getdel?(key: string): Promise<string | null>;
}

export class InMemoryAuthCache implements AuthKeyValueCache {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + Math.max(1, ttlSec) * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async getdel(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    this.store.delete(key);
    if (Date.now() >= entry.expiresAt) {
      return null;
    }
    return entry.value;
  }
}

/**
 * In-memory `AuthStore` implementation for deterministic unit/contract tests without Postgres.
 */
export class InMemoryAuthStore implements AuthStore {
  readonly users = new Map<string, UserRecord>();
  readonly workspaces = new Map<string, WorkspaceRecord>();
  readonly memberships = new Map<string, WorkspaceRole>();
  readonly sessions = new Map<string, AuthSessionRecord>();
  readonly pats = new Map<string, PatRecord>();
  readonly oauthClients = new Map<string, OAuthClientRecord>();
  readonly oauthCodes = new Map<string, OAuthAuthCodeRecord>();
  readonly oauthTokens = new Map<string, OAuthTokenRecord>();
  readonly projectGrants = new Map<string, ProjectGrantRecord>();

  setRole(workspaceId: string, userId: string, role: WorkspaceRole): void {
    this.memberships.set(`${workspaceId}:${userId}`, role);
  }

  seedWorkspace(input: {
    workspaceId?: string;
    userId?: string;
    oidcSub?: string;
    email?: string;
    displayName?: string;
    role?: WorkspaceRole;
    slug?: string;
    name?: string;
  }): MembershipResolution {
    const userId = input.userId ?? randomUUID();
    const workspaceId = input.workspaceId ?? randomUUID();
    const user: UserRecord = {
      id: userId,
      oidcSub: input.oidcSub ?? `oidc:${userId}`,
      email: input.email ?? 'user@example.com',
      displayName: input.displayName ?? 'Test User',
      avatarUrl: null,
      planTier: 'pro',
    };
    const workspace: WorkspaceRecord = {
      id: workspaceId,
      slug: input.slug ?? `ws-${workspaceId.slice(0, 8)}`,
      externalWorkspaceId: null,
      name: input.name ?? 'Test Workspace',
      ownerUserId: userId,
      defaultModels: {},
    };
    const role = input.role ?? 'owner';
    this.users.set(userId, user);
    this.workspaces.set(workspaceId, workspace);
    this.memberships.set(`${workspaceId}:${userId}`, role);
    return { user, workspace, role };
  }

  async findUserById(userId: string): Promise<UserRecord | null> {
    return this.users.get(userId) ?? null;
  }

  async findUserByOidcSub(oidcSub: string): Promise<UserRecord | null> {
    for (const user of this.users.values()) {
      if (user.oidcSub === oidcSub) return user;
    }
    return null;
  }

  async upsertOidcUserAndWorkspace(input: {
    oidcSub: string;
    email?: string | null;
    displayName: string;
    avatarUrl?: string | null;
    externalWorkspaceId?: string | null;
  }): Promise<MembershipResolution> {
    let user = await this.findUserByOidcSub(input.oidcSub);
    if (!user) {
      user = {
        id: randomUUID(),
        oidcSub: input.oidcSub,
        email: input.email ?? null,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl ?? null,
        planTier: null,
      };
      this.users.set(user.id, user);
    } else {
      user = {
        ...user,
        email: input.email ?? user.email,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl ?? user.avatarUrl,
      };
      this.users.set(user.id, user);
    }

    for (const [key, role] of this.memberships.entries()) {
      const [wsId, uId] = key.split(':');
      if (uId === user.id) {
        const ws = this.workspaces.get(wsId);
        if (ws) return { user, workspace: ws, role };
      }
    }

    const wsId = randomUUID();
    const workspace: WorkspaceRecord = {
      id: wsId,
      slug: `ws-${wsId.slice(0, 8)}`,
      externalWorkspaceId: input.externalWorkspaceId ?? null,
      name: `${user.displayName}'s Workspace`,
      ownerUserId: user.id,
      defaultModels: {},
    };
    this.workspaces.set(wsId, workspace);
    this.memberships.set(`${wsId}:${user.id}`, 'owner');
    return { user, workspace, role: 'owner' };
  }

  async findWorkspaceByExternalId(externalWorkspaceId: string): Promise<WorkspaceRecord | null> {
    for (const ws of this.workspaces.values()) {
      if (ws.externalWorkspaceId === externalWorkspaceId) return ws;
    }
    return null;
  }

  async projectAmrUserAndWorkspace(input: {
    oidcSub: string;
    appUserId: string;
    email?: string | null;
    displayName: string;
    avatarUrl?: string | null;
    externalWorkspaceId: string;
    workspaceName: string;
    role: WorkspaceRole;
  }): Promise<MembershipResolution> {
    let user = await this.findUserByOidcSub(input.oidcSub);
    if (!user) {
      user = {
        id: randomUUID(),
        oidcSub: input.oidcSub,
        appUserId: input.appUserId,
        email: input.email ?? null,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl ?? null,
        planTier: null,
      };
      this.users.set(user.id, user);
    } else {
      user = {
        ...user,
        appUserId: input.appUserId,
        email: input.email ?? user.email,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl ?? user.avatarUrl,
      };
      this.users.set(user.id, user);
    }

    let workspace = await this.findWorkspaceByExternalId(input.externalWorkspaceId);
    if (!workspace) {
      const wsId = randomUUID();
      workspace = {
        id: wsId,
        slug: slugFromIdentifier(input.workspaceName || input.externalWorkspaceId),
        externalWorkspaceId: input.externalWorkspaceId,
        name: input.workspaceName.slice(0, 120),
        ownerUserId: user.id,
        defaultModels: {},
      };
      this.workspaces.set(wsId, workspace);
    } else if (workspace.name !== input.workspaceName.slice(0, 120)) {
      workspace = { ...workspace, name: input.workspaceName.slice(0, 120) };
      this.workspaces.set(workspace.id, workspace);
    }

    this.memberships.set(`${workspace.id}:${user.id}`, input.role);
    return { user, workspace, role: input.role };
  }

  async ensureDevTenant(input: {
    workspaceId: string;
    userId: string;
    email?: string;
    displayName?: string;
  }): Promise<MembershipResolution> {
    const existing = await this.findMembership(input.workspaceId, input.userId);
    if (existing) return existing;
    return this.seedWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      oidcSub: 'dev:local',
      email: input.email ?? 'dev@localhost',
      displayName: input.displayName ?? 'Local Developer',
      role: 'owner',
      slug: 'dev-local',
      name: 'Local Workspace',
    });
  }

  async listUserWorkspaces(userId: string): Promise<UserWorkspaceSummary[]> {
    const out: UserWorkspaceSummary[] = [];
    for (const [key, role] of this.memberships.entries()) {
      const [wsId, uId] = key.split(':');
      if (uId !== userId) continue;
      const ws = this.workspaces.get(wsId);
      if (ws) {
        out.push({
          id: ws.id,
          slug: ws.slug,
          name: ws.name,
          role,
          externalWorkspaceId: ws.externalWorkspaceId,
        });
      }
    }
    return out;
  }

  async findMembership(workspaceId: string, userId: string): Promise<MembershipResolution | null> {
    const role = this.memberships.get(`${workspaceId}:${userId}`);
    if (!role) return null;
    const user = this.users.get(userId);
    const workspace = this.workspaces.get(workspaceId);
    if (!user || !workspace) return null;
    return { user, workspace, role };
  }

  async findWorkspaceById(workspaceId: string): Promise<WorkspaceRecord | null> {
    return this.workspaces.get(workspaceId) ?? null;
  }

  async updateWorkspaceDefaultModels(
    workspaceId: string,
    defaultModels: WorkspaceDefaultModels,
  ): Promise<WorkspaceDefaultModels> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) {
      throw new CloudError('NOT_FOUND', 'Workspace not found', { status: 404 });
    }
    ws.defaultModels = { ...defaultModels };
    return ws.defaultModels;
  }

  async createSession(input: {
    userId: string;
    workspaceId: string;
    tokenHash: string;
    csrfTokenHash: string;
    expiresAt: Date;
  }): Promise<AuthSessionRecord> {
    const now = new Date();
    const record: AuthSessionRecord = {
      id: randomUUID(),
      userId: input.userId,
      workspaceId: input.workspaceId,
      tokenHash: input.tokenHash,
      csrfTokenHash: input.csrfTokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
      lastSeenAt: now,
      createdAt: now,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  async findActiveSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.tokenHash === tokenHash && !s.revokedAt && s.expiresAt.getTime() > now) {
        return s;
      }
    }
    return null;
  }

  async touchSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.lastSeenAt = new Date();
  }

  async updateSessionWorkspace(sessionId: string, workspaceId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s || s.revokedAt) return false;
    s.workspaceId = workspaceId;
    s.lastSeenAt = new Date();
    return true;
  }

  async revokeSessionById(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s || s.revokedAt) return false;
    s.revokedAt = new Date();
    return true;
  }

  async revokeSessionByTokenHash(tokenHash: string): Promise<boolean> {
    for (const s of this.sessions.values()) {
      if (s.tokenHash === tokenHash && !s.revokedAt) {
        s.revokedAt = new Date();
        return true;
      }
    }
    return false;
  }

  async createPat(input: {
    workspaceId: string;
    userId: string;
    name: string;
    tokenPrefix: string;
    tokenHash: string;
    scopes: PatScope[];
    expiresAt: Date | null;
  }): Promise<PatRecord> {
    const record: PatRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      name: input.name,
      tokenPrefix: input.tokenPrefix,
      tokenHash: input.tokenHash,
      scopes: [...input.scopes],
      expiresAt: input.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.pats.set(record.id, record);
    return record;
  }

  async findActivePatByHash(tokenHash: string): Promise<PatRecord | null> {
    const now = Date.now();
    for (const p of this.pats.values()) {
      if (
        p.tokenHash === tokenHash &&
        !p.revokedAt &&
        (!p.expiresAt || p.expiresAt.getTime() > now)
      ) {
        return p;
      }
    }
    return null;
  }

  async listPats(workspaceId: string, userId?: string): Promise<PatRecord[]> {
    return [...this.pats.values()].filter(
      (p) => p.workspaceId === workspaceId && (!userId || p.userId === userId),
    );
  }

  async touchPat(tokenId: string): Promise<void> {
    const p = this.pats.get(tokenId);
    if (p) p.lastUsedAt = new Date();
  }

  async revokePat(workspaceId: string, tokenId: string, userId?: string): Promise<boolean> {
    const p = this.pats.get(tokenId);
    if (!p || p.workspaceId !== workspaceId || p.revokedAt) return false;
    if (userId && p.userId !== userId) return false;
    p.revokedAt = new Date();
    return true;
  }

  async createOAuthClient(input: {
    clientId: string;
    clientSecretHash: string | null;
    clientName: string;
    redirectUris: string[];
    grantTypes: string[];
    tokenEndpointAuthMethod: OAuthAuthMethod;
  }): Promise<OAuthClientRecord> {
    const record: OAuthClientRecord = { ...input, createdAt: new Date() };
    this.oauthClients.set(record.clientId, record);
    return record;
  }

  async findOAuthClient(clientId: string): Promise<OAuthClientRecord | null> {
    return this.oauthClients.get(clientId) ?? null;
  }

  async createOAuthAuthCode(input: {
    codeHash: string;
    clientId: string;
    userId: string;
    workspaceId: string;
    redirectUri: string;
    scope: string;
    codeChallenge: string;
    resource: string | null;
    expiresAt: Date;
  }): Promise<OAuthAuthCodeRecord> {
    const record: OAuthAuthCodeRecord = {
      ...input,
      codeChallengeMethod: 'S256',
      consumedAt: null,
      createdAt: new Date(),
    };
    this.oauthCodes.set(record.codeHash, record);
    return record;
  }

  async consumeOAuthAuthCode(codeHash: string): Promise<OAuthAuthCodeRecord | null> {
    const row = this.oauthCodes.get(codeHash);
    if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) return null;
    row.consumedAt = new Date();
    return row;
  }

  async createOAuthToken(input: {
    clientId: string;
    userId: string;
    workspaceId: string;
    accessTokenHash: string;
    refreshTokenHash: string | null;
    scope: string;
    resource: string | null;
    accessExpiresAt: Date;
    refreshExpiresAt: Date | null;
  }): Promise<OAuthTokenRecord> {
    const record: OAuthTokenRecord = {
      id: randomUUID(),
      ...input,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.oauthTokens.set(record.id, record);
    return record;
  }

  async findActiveOAuthTokenByAccessHash(accessTokenHash: string): Promise<OAuthTokenRecord | null> {
    const now = Date.now();
    for (const t of this.oauthTokens.values()) {
      if (
        t.accessTokenHash === accessTokenHash &&
        !t.revokedAt &&
        t.accessExpiresAt.getTime() > now
      ) {
        return t;
      }
    }
    return null;
  }

  async findActiveOAuthTokenByRefreshHash(refreshTokenHash: string): Promise<OAuthTokenRecord | null> {
    const now = Date.now();
    for (const t of this.oauthTokens.values()) {
      if (
        t.refreshTokenHash === refreshTokenHash &&
        !t.revokedAt &&
        t.refreshExpiresAt &&
        t.refreshExpiresAt.getTime() > now
      ) {
        return t;
      }
    }
    return null;
  }

  async findOAuthTokenByRefreshHash(refreshTokenHash: string): Promise<OAuthTokenRecord | null> {
    for (const t of this.oauthTokens.values()) {
      if (t.refreshTokenHash === refreshTokenHash) return t;
    }
    return null;
  }

  async revokeOAuthTokenById(tokenId: string): Promise<boolean> {
    const t = this.oauthTokens.get(tokenId);
    if (!t || t.revokedAt) return false;
    t.revokedAt = new Date();
    return true;
  }

  async revokeOAuthTokenByHash(hash: string): Promise<boolean> {
    for (const t of this.oauthTokens.values()) {
      if ((t.accessTokenHash === hash || t.refreshTokenHash === hash) && !t.revokedAt) {
        t.revokedAt = new Date();
        t.refreshTokenHash = null;
        return true;
      }
    }
    return false;
  }

  async touchOAuthToken(tokenId: string): Promise<void> {
    const t = this.oauthTokens.get(tokenId);
    if (t) t.lastUsedAt = new Date();
  }

  async listConnectedApps(userId: string): Promise<ConnectedAppSummary[]> {
    const now = Date.now();
    const byClient = new Map<
      string,
      {
        client: OAuthClientRecord;
        workspaceId: string;
        scopes: Set<string>;
        firstAuthorizedAt: Date;
        lastUsedAt: Date | null;
        activeTokenCount: number;
      }
    >();

    for (const t of this.oauthTokens.values()) {
      if (t.userId !== userId || t.revokedAt) continue;
      const accessActive = t.accessExpiresAt.getTime() > now;
      const refreshActive = Boolean(t.refreshExpiresAt && t.refreshExpiresAt.getTime() > now);
      if (!accessActive && !refreshActive) continue;
      const client = this.oauthClients.get(t.clientId);
      if (!client) continue;

      let entry = byClient.get(t.clientId);
      if (!entry) {
        entry = {
          client,
          workspaceId: t.workspaceId,
          scopes: new Set<string>(),
          firstAuthorizedAt: t.createdAt,
          lastUsedAt: t.lastUsedAt ?? null,
          activeTokenCount: 0,
        };
        byClient.set(t.clientId, entry);
      }
      for (const s of t.scope.split(/\s+/).filter(Boolean)) entry.scopes.add(s);
      if (t.createdAt < entry.firstAuthorizedAt) entry.firstAuthorizedAt = t.createdAt;
      if (t.lastUsedAt && (!entry.lastUsedAt || t.lastUsedAt > entry.lastUsedAt)) {
        entry.lastUsedAt = t.lastUsedAt;
      }
      entry.activeTokenCount += 1;
    }

    return [...byClient.values()].map((e) => ({
      clientId: e.client.clientId,
      clientName: e.client.clientName,
      redirectUris: [...e.client.redirectUris],
      workspaceId: e.workspaceId,
      scopes: [...e.scopes],
      firstAuthorizedAt: e.firstAuthorizedAt,
      lastUsedAt: e.lastUsedAt,
      activeTokenCount: e.activeTokenCount,
    }));
  }

  async revokeOAuthClientForUser(userId: string, clientId: string): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const t of this.oauthTokens.values()) {
      if (t.userId === userId && t.clientId === clientId && !t.revokedAt) {
        t.revokedAt = now;
        t.refreshTokenHash = null;
        count += 1;
      }
    }
    return count;
  }

  async cleanupUnusedOAuthClients(olderThan: Date): Promise<number> {
    const usedClients = new Set<string>();
    for (const t of this.oauthTokens.values()) {
      usedClients.add(t.clientId);
    }
    let deleted = 0;
    for (const [clientId, client] of this.oauthClients.entries()) {
      if (!usedClients.has(clientId) && client.createdAt < olderThan) {
        this.oauthClients.delete(clientId);
        deleted += 1;
      }
    }
    return deleted;
  }

  async grantProjectAccess(input: {
    projectId: string;
    userId: string;
    workspaceId: string;
    clientId: string;
  }): Promise<ProjectGrantRecord> {
    const key = `${input.projectId}:${input.userId}:${input.clientId}`;
    const existing = this.projectGrants.get(key);
    const now = new Date();
    const record: ProjectGrantRecord = {
      id: existing?.id ?? randomUUID(),
      projectId: input.projectId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      clientId: input.clientId,
      grantedAt: now,
      revokedAt: null,
    };
    this.projectGrants.set(key, record);
    return record;
  }

  async revokeProjectAccess(input: {
    projectId: string;
    userId: string;
    clientId: string;
  }): Promise<boolean> {
    const key = `${input.projectId}:${input.userId}:${input.clientId}`;
    const existing = this.projectGrants.get(key);
    if (!existing || existing.revokedAt) return false;
    existing.revokedAt = new Date();
    return true;
  }

  async hasActiveProjectGrant(input: {
    projectId: string;
    userId: string;
    clientId: string;
  }): Promise<boolean> {
    const key = `${input.projectId}:${input.userId}:${input.clientId}`;
    const existing = this.projectGrants.get(key);
    return Boolean(existing && !existing.revokedAt);
  }

  async listProjectGrants(projectId: string, userId: string): Promise<ProjectGrantRecord[]> {
    return [...this.projectGrants.values()].filter(
      (g) => g.projectId === projectId && g.userId === userId,
    );
  }
}

export function createRedisAuthCache(redis: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', duration: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  getdel?(key: string): Promise<string | null>;
  eval?(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
}): AuthKeyValueCache {
  return {
    async get(key: string) {
      return redis.get(key);
    },
    async set(key: string, value: string, ttlSec: number) {
      await redis.set(key, value, 'EX', Math.max(1, Math.floor(ttlSec)));
    },
    async del(key: string) {
      await redis.del(key);
    },
    async getdel(key: string) {
      if (typeof redis.getdel === 'function') {
        return redis.getdel(key);
      }
      if (typeof redis.eval === 'function') {
        const res = await redis.eval(
          "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]); end; return v",
          1,
          key,
        );
        return typeof res === 'string' ? res : null;
      }
      const value = await redis.get(key);
      if (value === null) return null;
      await redis.del(key);
      return value;
    },
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL (Drizzle) Implementation
// ---------------------------------------------------------------------------

function slugFromIdentifier(seed: string): string {
  const cleaned = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${cleaned || 'workspace'}-${randomHex(4)}`;
}

export function createPgAuthStore(db: Database): AuthStore {
  return {
    async findUserById(userId) {
      const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      return row ?? null;
    },

    async findUserByOidcSub(oidcSub) {
      const [row] = await db.select().from(users).where(eq(users.oidcSub, oidcSub)).limit(1);
      return row ?? null;
    },

    async upsertOidcUserAndWorkspace(input) {
      return db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values(
            asInsert(users, {
              oidcSub: input.oidcSub,
              email: input.email ?? null,
              displayName: input.displayName,
              avatarUrl: input.avatarUrl ?? null,
            }),
          )
          .onConflictDoUpdate({
            target: users.oidcSub,
            set: asUpdate(users, {
              email: input.email ?? null,
              displayName: input.displayName,
              avatarUrl: input.avatarUrl ?? null,
              updatedAt: sql`now()`,
            }),
          })
          .returning();

        // Check existing external workspace mapping if claim was provided.
        if (input.externalWorkspaceId) {
          const [extWs] = await tx
            .select()
            .from(workspaces)
            .where(eq(workspaces.externalWorkspaceId, input.externalWorkspaceId))
            .limit(1);

          if (extWs) {
            const [member] = await tx
              .select()
              .from(workspaceMembers)
              .where(
                and(eq(workspaceMembers.workspaceId, extWs.id), eq(workspaceMembers.userId, user.id)),
              )
              .limit(1);
            if (member) {
              return { user, workspace: extWs, role: member.role };
            }
          }
        }

        // Otherwise resolve user's existing workspace membership (preferring owned).
        const existingMemberships = await tx
          .select({
            workspace: workspaces,
            role: workspaceMembers.role,
          })
          .from(workspaceMembers)
          .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
          .where(eq(workspaceMembers.userId, user.id))
          .limit(10);

        const preferred =
          existingMemberships.find((m) => m.role === 'owner') ?? existingMemberships[0];
        if (preferred) {
          return { user, workspace: preferred.workspace, role: preferred.role };
        }

        // First-time user: provision a personal workspace and owner membership.
        const [workspace] = await tx
          .insert(workspaces)
          .values(
            asInsert(workspaces, {
              slug: slugFromIdentifier(input.displayName || input.email || input.oidcSub),
              externalWorkspaceId: input.externalWorkspaceId ?? null,
              name: `${input.displayName}'s Workspace`.slice(0, 120),
              ownerUserId: user.id,
              defaultModels: {},
            }),
          )
          .returning();

        await tx.insert(workspaceMembers).values(
          asInsert(workspaceMembers, {
            workspaceId: workspace.id,
            userId: user.id,
            role: 'owner',
          }),
        );

        return { user, workspace, role: 'owner' as WorkspaceRole };
      });
    },

    async findWorkspaceByExternalId(externalWorkspaceId) {
      const [row] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.externalWorkspaceId, externalWorkspaceId))
        .limit(1);
      return row ?? null;
    },

    async projectAmrUserAndWorkspace(input) {
      return db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values(
            asInsert(users, {
              oidcSub: input.oidcSub,
              appUserId: input.appUserId,
              email: input.email ?? null,
              displayName: input.displayName,
              avatarUrl: input.avatarUrl ?? null,
            }),
          )
          .onConflictDoUpdate({
            target: users.oidcSub,
            set: asUpdate(users, {
              appUserId: input.appUserId,
              email: input.email ?? null,
              displayName: input.displayName,
              avatarUrl: input.avatarUrl ?? null,
              updatedAt: sql`now()`,
            }),
          })
          .returning();

        const wsName = input.workspaceName.slice(0, 120) || 'Workspace';
        const [insertedWs] = await tx
          .insert(workspaces)
          .values(
            asInsert(workspaces, {
              slug: slugFromIdentifier(wsName || input.externalWorkspaceId),
              externalWorkspaceId: input.externalWorkspaceId,
              name: wsName,
              ownerUserId: user.id,
              defaultModels: {},
            }),
          )
          .onConflictDoUpdate({
            target: workspaces.externalWorkspaceId,
            set: asUpdate(workspaces, {
              name: wsName,
              updatedAt: sql`now()`,
            }),
          })
          .returning();

        await tx
          .insert(workspaceMembers)
          .values(
            asInsert(workspaceMembers, {
              workspaceId: insertedWs.id,
              userId: user.id,
              role: input.role,
            }),
          )
          .onConflictDoUpdate({
            target: [workspaceMembers.workspaceId, workspaceMembers.userId],
            set: asUpdate(workspaceMembers, {
              role: input.role,
            }),
          });

        return { user, workspace: insertedWs, role: input.role };
      });
    },

    async ensureDevTenant(input) {
      return db.transaction(async (tx) => {
        const displayName = input.displayName ?? 'Local Developer';
        const email = input.email ?? 'dev@localhost';

        const [user] = await tx
          .insert(users)
          .values(
            asInsert(users, {
              id: input.userId,
              oidcSub: 'dev:local',
              email,
              displayName,
              planTier: 'dev',
            }),
          )
          .onConflictDoUpdate({
            target: users.id,
            set: asUpdate(users, {
              email,
              displayName,
              updatedAt: sql`now()`,
            }),
          })
          .returning();

        const [workspace] = await tx
          .insert(workspaces)
          .values(
            asInsert(workspaces, {
              id: input.workspaceId,
              slug: 'dev-local',
              name: 'Local Workspace',
              ownerUserId: user.id,
              defaultModels: {},
            }),
          )
          .onConflictDoNothing({ target: workspaces.id })
          .returning();

        const resolvedWorkspace =
          workspace ??
          (await tx
            .select()
            .from(workspaces)
            .where(eq(workspaces.id, input.workspaceId))
            .limit(1)
            .then((rows) => rows[0]));

        if (!resolvedWorkspace) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Failed to provision dev workspace', {
            status: 500,
          });
        }

        await tx
          .insert(workspaceMembers)
          .values(
            asInsert(workspaceMembers, {
              workspaceId: resolvedWorkspace.id,
              userId: user.id,
              role: 'owner',
            }),
          )
          .onConflictDoNothing();

        return { user, workspace: resolvedWorkspace, role: 'owner' as WorkspaceRole };
      });
    },

    async listUserWorkspaces(userId) {
      const rows = await db
        .select({
          id: workspaces.id,
          slug: workspaces.slug,
          name: workspaces.name,
          role: workspaceMembers.role,
          externalWorkspaceId: workspaces.externalWorkspaceId,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(eq(workspaceMembers.userId, userId));
      return rows;
    },

    async findMembership(workspaceId, userId) {
      const [row] = await db
        .select({
          user: users,
          workspace: workspaces,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(
          and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
        )
        .limit(1);
      return row ?? null;
    },

    async findWorkspaceById(workspaceId) {
      const [row] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      return row ?? null;
    },

    async updateWorkspaceDefaultModels(workspaceId, defaultModels) {
      const [updated] = await db
        .update(workspaces)
        .set(asUpdate(workspaces, { defaultModels, updatedAt: sql`now()` }))
        .where(eq(workspaces.id, workspaceId))
        .returning({ defaultModels: workspaces.defaultModels });
      if (!updated) {
        throw new CloudError('NOT_FOUND', 'Workspace not found', { status: 404 });
      }
      return updated.defaultModels;
    },

    async createSession(input) {
      const [row] = await db
        .insert(authSessions)
        .values(
          asInsert(authSessions, {
            userId: input.userId,
            workspaceId: input.workspaceId,
            tokenHash: input.tokenHash,
            csrfTokenHash: input.csrfTokenHash,
            expiresAt: input.expiresAt,
          }),
        )
        .returning();
      return row;
    },

    async findActiveSessionByTokenHash(tokenHash) {
      const now = new Date();
      const [row] = await db
        .select()
        .from(authSessions)
        .where(
          and(
            eq(authSessions.tokenHash, tokenHash),
            isNull(authSessions.revokedAt),
            gt(authSessions.expiresAt, now),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async touchSession(sessionId) {
      await db
        .update(authSessions)
        .set(asUpdate(authSessions, { lastSeenAt: sql`now()` }))
        .where(eq(authSessions.id, sessionId));
    },

    async updateSessionWorkspace(sessionId, workspaceId) {
      const rows = await db
        .update(authSessions)
        .set(asUpdate(authSessions, { workspaceId, lastSeenAt: sql`now()` }))
        .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)))
        .returning({ id: authSessions.id });
      return rows.length > 0;
    },

    async revokeSessionById(sessionId) {
      const rows = await db
        .update(authSessions)
        .set(asUpdate(authSessions, { revokedAt: sql`now()` }))
        .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)))
        .returning({ id: authSessions.id });
      return rows.length > 0;
    },

    async revokeSessionByTokenHash(tokenHash) {
      const rows = await db
        .update(authSessions)
        .set(asUpdate(authSessions, { revokedAt: sql`now()` }))
        .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt)))
        .returning({ id: authSessions.id });
      return rows.length > 0;
    },

    async createPat(input) {
      const [row] = await db
        .insert(personalAccessTokens)
        .values(
          asInsert(personalAccessTokens, {
            workspaceId: input.workspaceId,
            userId: input.userId,
            name: input.name,
            tokenPrefix: input.tokenPrefix,
            tokenHash: input.tokenHash,
            scopes: input.scopes,
            expiresAt: input.expiresAt,
          }),
        )
        .returning();
      return row;
    },

    async findActivePatByHash(tokenHash) {
      const now = new Date();
      const [row] = await db
        .select()
        .from(personalAccessTokens)
        .where(
          and(
            eq(personalAccessTokens.tokenHash, tokenHash),
            isNull(personalAccessTokens.revokedAt),
            or(
              isNull(personalAccessTokens.expiresAt),
              gt(personalAccessTokens.expiresAt, now),
            ),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listPats(workspaceId, userId) {
      const predicate = userId
        ? and(
            eq(personalAccessTokens.workspaceId, workspaceId),
            eq(personalAccessTokens.userId, userId),
          )
        : eq(personalAccessTokens.workspaceId, workspaceId);
      return db
        .select()
        .from(personalAccessTokens)
        .where(predicate)
        .orderBy(desc(personalAccessTokens.createdAt));
    },

    async touchPat(tokenId) {
      await db
        .update(personalAccessTokens)
        .set(asUpdate(personalAccessTokens, { lastUsedAt: sql`now()` }))
        .where(eq(personalAccessTokens.id, tokenId));
    },

    async revokePat(workspaceId, tokenId, userId) {
      const predicate = userId
        ? and(
            eq(personalAccessTokens.id, tokenId),
            eq(personalAccessTokens.workspaceId, workspaceId),
            eq(personalAccessTokens.userId, userId),
            isNull(personalAccessTokens.revokedAt),
          )
        : and(
            eq(personalAccessTokens.id, tokenId),
            eq(personalAccessTokens.workspaceId, workspaceId),
            isNull(personalAccessTokens.revokedAt),
          );
      const rows = await db
        .update(personalAccessTokens)
        .set(asUpdate(personalAccessTokens, { revokedAt: sql`now()` }))
        .where(predicate)
        .returning({ id: personalAccessTokens.id });
      return rows.length > 0;
    },

    async createOAuthClient(input) {
      const [row] = await db
        .insert(oauthClients)
        .values(
          asInsert(oauthClients, {
            clientId: input.clientId,
            clientSecretHash: input.clientSecretHash,
            clientName: input.clientName,
            redirectUris: input.redirectUris,
            grantTypes: input.grantTypes,
            tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
          }),
        )
        .returning();
      return {
        ...row,
        tokenEndpointAuthMethod: row.tokenEndpointAuthMethod as OAuthAuthMethod,
      };
    },

    async findOAuthClient(clientId) {
      const [row] = await db
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.clientId, clientId))
        .limit(1);
      if (!row) return null;
      return {
        ...row,
        tokenEndpointAuthMethod: row.tokenEndpointAuthMethod as OAuthAuthMethod,
      };
    },

    async createOAuthAuthCode(input) {
      const [row] = await db
        .insert(oauthAuthorizationCodes)
        .values(
          asInsert(oauthAuthorizationCodes, {
            codeHash: input.codeHash,
            clientId: input.clientId,
            userId: input.userId,
            workspaceId: input.workspaceId,
            redirectUri: input.redirectUri,
            scope: input.scope,
            codeChallenge: input.codeChallenge,
            codeChallengeMethod: 'S256',
            resource: input.resource,
            expiresAt: input.expiresAt,
          }),
        )
        .returning();
      return {
        ...row,
        codeChallengeMethod: 'S256',
      };
    },

    async consumeOAuthAuthCode(codeHash) {
      const now = new Date();
      const [row] = await db
        .update(oauthAuthorizationCodes)
        .set(asUpdate(oauthAuthorizationCodes, { consumedAt: now }))
        .where(
          and(
            eq(oauthAuthorizationCodes.codeHash, codeHash),
            isNull(oauthAuthorizationCodes.consumedAt),
            gt(oauthAuthorizationCodes.expiresAt, now),
          ),
        )
        .returning();
      if (!row) return null;
      return {
        ...row,
        codeChallengeMethod: 'S256',
      };
    },

    async createOAuthToken(input) {
      const [row] = await db
        .insert(oauthTokens)
        .values(
          asInsert(oauthTokens, {
            clientId: input.clientId,
            userId: input.userId,
            workspaceId: input.workspaceId,
            accessTokenHash: input.accessTokenHash,
            refreshTokenHash: input.refreshTokenHash,
            scope: input.scope,
            resource: input.resource,
            accessExpiresAt: input.accessExpiresAt,
            refreshExpiresAt: input.refreshExpiresAt,
          }),
        )
        .returning();
      return row;
    },

    async findActiveOAuthTokenByAccessHash(accessTokenHash) {
      const now = new Date();
      const [row] = await db
        .select()
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.accessTokenHash, accessTokenHash),
            isNull(oauthTokens.revokedAt),
            gt(oauthTokens.accessExpiresAt, now),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async findActiveOAuthTokenByRefreshHash(refreshTokenHash) {
      const now = new Date();
      const [row] = await db
        .select()
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.refreshTokenHash, refreshTokenHash),
            isNull(oauthTokens.revokedAt),
            gt(oauthTokens.refreshExpiresAt, now),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async findOAuthTokenByRefreshHash(refreshTokenHash) {
      const [row] = await db
        .select()
        .from(oauthTokens)
        .where(eq(oauthTokens.refreshTokenHash, refreshTokenHash))
        .limit(1);
      return row ?? null;
    },

    async revokeOAuthTokenById(tokenId) {
      const rows = await db
        .update(oauthTokens)
        .set(asUpdate(oauthTokens, { revokedAt: sql`now()` }))
        .where(and(eq(oauthTokens.id, tokenId), isNull(oauthTokens.revokedAt)))
        .returning({ id: oauthTokens.id });
      return rows.length > 0;
    },

    async revokeOAuthTokenByHash(hash) {
      const rows = await db
        .update(oauthTokens)
        .set(asUpdate(oauthTokens, { revokedAt: sql`now()`, refreshTokenHash: null }))
        .where(
          and(
            or(eq(oauthTokens.accessTokenHash, hash), eq(oauthTokens.refreshTokenHash, hash)),
            isNull(oauthTokens.revokedAt),
          ),
        )
        .returning({ id: oauthTokens.id });
      return rows.length > 0;
    },

    async touchOAuthToken(tokenId) {
      await db
        .update(oauthTokens)
        .set(asUpdate(oauthTokens, { lastUsedAt: sql`now()` }))
        .where(eq(oauthTokens.id, tokenId));
    },

    async listConnectedApps(userId) {
      const now = new Date();
      const rows = await db
        .select({
          token: oauthTokens,
          client: oauthClients,
        })
        .from(oauthTokens)
        .innerJoin(oauthClients, eq(oauthTokens.clientId, oauthClients.clientId))
        .where(
          and(
            eq(oauthTokens.userId, userId),
            isNull(oauthTokens.revokedAt),
            or(gt(oauthTokens.accessExpiresAt, now), gt(oauthTokens.refreshExpiresAt, now)),
          ),
        )
        .orderBy(desc(oauthTokens.createdAt));

      const byClient = new Map<
        string,
        {
          clientId: string;
          clientName: string;
          redirectUris: string[];
          workspaceId: string;
          scopes: Set<string>;
          firstAuthorizedAt: Date;
          lastUsedAt: Date | null;
          activeTokenCount: number;
        }
      >();

      for (const { token, client } of rows) {
        let entry = byClient.get(client.clientId);
        if (!entry) {
          entry = {
            clientId: client.clientId,
            clientName: client.clientName,
            redirectUris: [...client.redirectUris],
            workspaceId: token.workspaceId,
            scopes: new Set<string>(),
            firstAuthorizedAt: token.createdAt,
            lastUsedAt: token.lastUsedAt ?? null,
            activeTokenCount: 0,
          };
          byClient.set(client.clientId, entry);
        }
        for (const s of token.scope.split(/\s+/).filter(Boolean)) entry.scopes.add(s);
        if (token.createdAt < entry.firstAuthorizedAt) entry.firstAuthorizedAt = token.createdAt;
        if (token.lastUsedAt && (!entry.lastUsedAt || token.lastUsedAt > entry.lastUsedAt)) {
          entry.lastUsedAt = token.lastUsedAt;
        }
        entry.activeTokenCount += 1;
      }

      return [...byClient.values()].map((e) => ({
        clientId: e.clientId,
        clientName: e.clientName,
        redirectUris: e.redirectUris,
        workspaceId: e.workspaceId,
        scopes: [...e.scopes],
        firstAuthorizedAt: e.firstAuthorizedAt,
        lastUsedAt: e.lastUsedAt,
        activeTokenCount: e.activeTokenCount,
      }));
    },

    async revokeOAuthClientForUser(userId, clientId) {
      const rows = await db
        .update(oauthTokens)
        .set(asUpdate(oauthTokens, { revokedAt: sql`now()`, refreshTokenHash: null }))
        .where(
          and(
            eq(oauthTokens.userId, userId),
            eq(oauthTokens.clientId, clientId),
            isNull(oauthTokens.revokedAt),
          ),
        )
        .returning({ id: oauthTokens.id });
      return rows.length;
    },

    async cleanupUnusedOAuthClients(olderThan) {
      const rows = await db
        .delete(oauthClients)
        .where(
          and(
            lt(oauthClients.createdAt, olderThan),
            notExists(
              db
                .select({ id: oauthTokens.id })
                .from(oauthTokens)
                .where(eq(oauthTokens.clientId, oauthClients.clientId)),
            ),
          ),
        )
        .returning({ clientId: oauthClients.clientId });
      return rows.length;
    },

    async grantProjectAccess(input) {
      const [row] = await db
        .insert(projectGrants)
        .values(
          asInsert(projectGrants, {
            projectId: input.projectId,
            userId: input.userId,
            workspaceId: input.workspaceId,
            clientId: input.clientId,
            grantedAt: sql`now()`,
            revokedAt: null,
          }),
        )
        .onConflictDoUpdate({
          target: [projectGrants.projectId, projectGrants.userId, projectGrants.clientId],
          set: asUpdate(projectGrants, {
            workspaceId: input.workspaceId,
            grantedAt: sql`now()`,
            revokedAt: null,
          }),
        })
        .returning();
      return row;
    },

    async revokeProjectAccess(input) {
      const rows = await db
        .update(projectGrants)
        .set(asUpdate(projectGrants, { revokedAt: sql`now()` }))
        .where(
          and(
            eq(projectGrants.projectId, input.projectId),
            eq(projectGrants.userId, input.userId),
            eq(projectGrants.clientId, input.clientId),
            isNull(projectGrants.revokedAt),
          ),
        )
        .returning({ id: projectGrants.id });
      return rows.length > 0;
    },

    async hasActiveProjectGrant(input) {
      const [row] = await db
        .select({ id: projectGrants.id })
        .from(projectGrants)
        .where(
          and(
            eq(projectGrants.projectId, input.projectId),
            eq(projectGrants.userId, input.userId),
            eq(projectGrants.clientId, input.clientId),
            isNull(projectGrants.revokedAt),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    async listProjectGrants(projectId, userId) {
      return db
        .select()
        .from(projectGrants)
        .where(and(eq(projectGrants.projectId, projectId), eq(projectGrants.userId, userId)))
        .orderBy(desc(projectGrants.grantedAt));
    },
  };
}
