import { CloudError } from './errors.ts';

export const WORKSPACE_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const AUTH_MODES = ['oidc', 'dev'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const AUTH_METHODS = [
  'session_cookie',
  'pat',
  'oauth_bearer',
  'oidc_jwt',
  'preview_token',
  'dev_bypass',
] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const PAT_SCOPES = [
  'projects:read',
  'projects:write',
  'assets:read',
  'assets:write',
  'exports:write',
  'media:generate',
  'mcp:tools',
  'workspace:admin',
] as const;
export type PatScope = (typeof PAT_SCOPES)[number];

export const DEFAULT_PAT_SCOPES: readonly PatScope[] = [
  'projects:read',
  'projects:write',
  'assets:read',
  'assets:write',
  'exports:write',
  'media:generate',
  'mcp:tools',
] as const;

export const ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

export const AUTH_ENTRIES = ['web', 'mcp', 'api'] as const;
export type AuthEntry = (typeof AUTH_ENTRIES)[number];

export const AMR_WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;
export type AmrWorkspaceRole = (typeof AMR_WORKSPACE_ROLES)[number];

export const EFFECTIVE_WRITE_ACCESS_VALUES = ['writable', 'read_only', 'unknown'] as const;
export type EffectiveWriteAccess = (typeof EFFECTIVE_WRITE_ACCESS_VALUES)[number];

export interface AuthContext {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly scopes: readonly PatScope[];
  readonly authMode: AuthMode;
  readonly authMethod: AuthMethod;
  readonly externalWorkspaceId?: string | null;
  readonly authUserId?: string | null;
  readonly appUserId?: string | null;
  readonly clientId?: string | null;
  readonly entry?: AuthEntry;
  readonly amrWorkspaceMemberId?: string | null;
  readonly amrWorkspaceRole?: AmrWorkspaceRole | null;
  readonly amrWorkspaceLifecycleState?: string | null;
  readonly effectiveWriteAccess?: EffectiveWriteAccess;
  readonly sessionId?: string;
  readonly tokenId?: string;
  readonly email?: string | null;
  readonly displayName?: string;
  readonly avatarUrl?: string | null;
}

export function hasScope(ctx: Pick<AuthContext, 'scopes'>, required: PatScope): boolean {
  return ctx.scopes.includes('workspace:admin') || ctx.scopes.includes(required);
}

/** Hosted Studio prepares the edited file locally. Headless integrations can send an intent. */
export function requireProgrammaticEdit(ctx: AuthContext): void {
  if (ctx.entry === 'web' || ctx.authMethod === 'session_cookie') {
    throw new CloudError('INVALID_ARGUMENT', 'Studio edits must submit prepared file changes to text-edits/batch.',
      { status: 400, applied: false });
  }
}

export function hasMinRole(ctx: Pick<AuthContext, 'role'>, minimum: WorkspaceRole): boolean {
  return ROLE_RANK[ctx.role] >= ROLE_RANK[minimum];
}
