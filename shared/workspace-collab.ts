/** Shared workspace collaboration, quota, referral, and cloud-handoff contracts. */

export const workspaceTypes = ['personal', 'team'] as const;
export type WorkspaceType = typeof workspaceTypes[number];

export const workspaceMemberRoles = ['owner', 'admin', 'member'] as const;
export type WorkspaceMemberRole = typeof workspaceMemberRoles[number];

export const workspaceMemberStatuses = ['active', 'removed'] as const;
export type WorkspaceMemberStatus = typeof workspaceMemberStatuses[number];

export const workspaceLifecycleStates = [
  'active',
  'billing_past_due',
  'locked',
  'deleting',
  'deleted',
] as const;
export type WorkspaceLifecycleState = typeof workspaceLifecycleStates[number];

export const workspaceBillingStates = [
  'free',
  'active',
  'past_due',
  'canceled',
  'inactive',
  'locked',
] as const;
export type WorkspaceBillingState = typeof workspaceBillingStates[number];

export type WorkspacePermissions = {
  canInviteMembers: boolean;
  canInviteAdmins: boolean;
  canManageBilling: boolean;
  canShowWorkspaceSettings: boolean;
  canManageWorkspace: boolean;
  canEditWorkspaceContent: boolean;
};

export type WorkspaceDirectoryEntry = {
  workspaceId: string;
  workspaceName: string;
  workspaceType: WorkspaceType;
  workspaceMemberId: string;
  role: WorkspaceMemberRole;
  isDefault: boolean;
  memberStatus: WorkspaceMemberStatus;
  lifecycleState: WorkspaceLifecycleState;
  billingState: WorkspaceBillingState;
  planId: string | null;
  memberCount?: number;
};

export type WorkspaceBillingQuota = {
  workspaceId: string;
  planId: string;
  planLabel: string;
  billingState: WorkspaceBillingState;
  lifecycleState: WorkspaceLifecycleState;
  weeklyPercentLeft: number | null;
  weeklyResetsAt: string | null;
  weeklyLimitExhausted: boolean;
  creditsUsd: string | null;
  creditsExhausted: boolean;
  hasAvailableFunds: boolean;
  unavailable?: boolean;
};

export type WorkspaceReferralSummary = {
  available: boolean;
  referralUrl: string | null;
  referralCode: string | null;
  resetCardsAvailable: number;
  invitedCount: number;
  inviteTarget: number;
  inviteeWindowActive: boolean;
  inviteeWindowEndsAt: string | null;
};

export type WorkspaceInviteRole = 'member' | 'admin';

export type WorkspaceInviteRowInput = {
  email: string;
  role: WorkspaceInviteRole;
  idempotencyKey?: string;
};

export type WorkspaceInviteRowResult = {
  email: string;
  role: WorkspaceInviteRole;
  ok: boolean;
  inviteId?: string;
  error?: string;
  message?: string;
};

export type WorkspaceCloudDestination =
  | 'plans'
  | 'billing'
  | 'members'
  | 'create-workspace'
  | 'billing-recovery'
  | 'referral'
  | 'workspace-settings';

export type ProjectVisibility = 'private' | 'workspace';

export const workspaceProjectKinds = ['motion', 'design', 'game'] as const;
export type WorkspaceProjectKind = typeof workspaceProjectKinds[number];

export const projectShareStatuses = ['personal', 'team_shared', 'team_private'] as const;
export type ProjectShareStatus = typeof projectShareStatuses[number];

export type ProjectCollabMeta = {
  projectId: string;
  workspaceId: string;
  visibility: ProjectVisibility;
  kind?: WorkspaceProjectKind;
  ownerMemberId?: string;
  ownerName?: string;
  teamSynced?: boolean;
  movedAt?: number;
  removedFromTeamAt?: number;
};

export type WorkspaceMemberEntry = {
  memberId: string;
  userId?: string;
  name: string;
  email?: string;
  role: WorkspaceMemberRole;
  status: WorkspaceMemberStatus;
  isCurrentUser?: boolean;
  joinedAt?: string;
};

export type WorkspaceMembersResponse = {
  workspaceId: string;
  workspaceName: string;
  workspaceType: WorkspaceType;
  members: WorkspaceMemberEntry[];
  totalCount: number;
  source: 'cloud_api' | 'vela_cli' | 'fallback';
  canInviteMembers: boolean;
  canInviteAdmins: boolean;
  canManageMembersInCloud: boolean;
};

export type UnifiedWorkspaceProject = {
  id: string;
  kind: WorkspaceProjectKind;
  title: string;
  titleKey?: 'OpenMotion Sample Video' | null;
  subtitle?: string;
  scenario?: string;
  previewUrl?: string | null;
  updatedAt?: number;
  trashed?: boolean;
  trashedAt?: number;
  shareStatus: ProjectShareStatus;
  workspaceId: string | null;
  workspaceName: string | null;
  visibility: ProjectVisibility;
  ownerMemberId?: string | null;
  ownerName?: string | null;
  isOwner: boolean;
  sharedAt?: number | null;
  teamSynced?: boolean;
  webPublish: {
    status: 'none' | 'published' | 'stopped';
    url?: string | null;
    updatedAt?: number;
  };
  permissions: {
    canOpen: boolean;
    canShareToTeam: boolean;
    canChangeVisibility: boolean;
    canRemoveFromTeam: boolean;
    canRename: boolean;
    canDelete: boolean;
  };
};

export type UnifiedWorkspaceProjectsCounts = {
  total: number;
  personal: number;
  teamShared: number;
  teamPrivate: number;
  motion: number;
  design: number;
  game: number;
  trashed: number;
};

export type UnifiedWorkspaceProjectsResponse = {
  activeWorkspaceId: string | null;
  activeWorkspaceName: string | null;
  activeWorkspaceType: WorkspaceType | null;
  projects: UnifiedWorkspaceProject[];
  trashed: UnifiedWorkspaceProject[];
  counts: UnifiedWorkspaceProjectsCounts;
};

export type CommentSyncState = 'synced' | 'pending' | 'failed';

export type CommentSyncStatus = {
  projectId: string;
  state: CommentSyncState;
  pendingCount: number;
  lastError?: string;
  updatedAt: number;
};

export type WorkspaceCollabPreferences = {
  skipMoveToTeamConfirm: boolean;
  skipRemoveFromTeamConfirm?: boolean;
  dismissedBanners: string[];
};

export type WorkspaceRemovalInfo = {
  workspaceId: string;
  workspaceName: string;
};

export type WorkspaceCollabSnapshot = {
  signedIn: boolean;
  accountState: string;
  user?: { name?: string; email?: string };
  workspaces: WorkspaceDirectoryEntry[];
  activeWorkspaceId: string | null;
  activeWorkspace: WorkspaceDirectoryEntry | null;
  permissions: WorkspacePermissions;
  removedFromWorkspace?: WorkspaceRemovalInfo | null;
  quota: WorkspaceBillingQuota | null;
  referral: WorkspaceReferralSummary | null;
  projectMeta: Record<string, ProjectCollabMeta>;
  commentSync: Record<string, CommentSyncStatus>;
  preferences: WorkspaceCollabPreferences;
};

export const EMPTY_WORKSPACE_PERMISSIONS: WorkspacePermissions = {
  canInviteMembers: false,
  canInviteAdmins: false,
  canManageBilling: false,
  canShowWorkspaceSettings: false,
  canManageWorkspace: false,
  canEditWorkspaceContent: true,
};

export function buildWorkspacePermissions(input: {
  workspaceType?: WorkspaceType | null;
  role?: WorkspaceMemberRole | null;
  lifecycleState?: WorkspaceLifecycleState | null;
  memberStatus?: WorkspaceMemberStatus | null;
}): WorkspacePermissions {
  const activeMember = input.memberStatus === 'active';
  const activeLifecycle = input.lifecycleState === 'active';
  const editableLifecycle =
    input.lifecycleState !== 'locked' && input.lifecycleState !== 'deleted' && input.lifecycleState !== 'deleting';
  const role = input.role;
  const isOwner = role === 'owner';
  const isManager = isOwner || role === 'admin';
  return {
    canInviteMembers: Boolean(activeMember && activeLifecycle && isManager),
    canInviteAdmins: Boolean(activeMember && activeLifecycle && isOwner),
    canManageBilling: Boolean(activeMember && isOwner),
    canShowWorkspaceSettings: Boolean(input.workspaceType === 'team' && activeMember && isManager),
    canManageWorkspace: Boolean(activeMember && isManager),
    canEditWorkspaceContent: Boolean(activeMember && editableLifecycle),
  };
}

export function isValidInviteEmail(raw: string): boolean {
  const email = raw.trim();
  if (!email || email.length > 254 || /\s/.test(email)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export function formatPlanLabel(planId: string | null | undefined): string {
  const normalized = (planId ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'free') return 'Free';
  if (normalized === 'go') return 'Go';
  if (normalized === 'plus' || normalized === 'team_plus') return 'Plus';
  if (normalized === 'pro' || normalized === 'team_pro') return 'Pro';
  if (normalized === 'max' || normalized === 'team_max') return 'Max';
  if (normalized.startsWith('team_')) {
    const suffix = normalized.slice('team_'.length);
    return `Team ${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}`;
  }
  return planId!.trim();
}

export type WorkspacePreflightReason =
  | 'ok'
  | 'insufficient_balance'
  | 'workspace_locked'
  | 'billing_past_due'
  | 'plan_not_entitled'
  | 'signed_out'
  | 'unavailable';

export type WorkspacePreflightResult = {
  funded: boolean;
  reason: WorkspacePreflightReason;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceType: WorkspaceType | null;
  planId: string;
  planLabel: string;
  balanceUsd: string | null;
  weeklyPercentLeft: number | null;
  weeklyResetsAt: string | null;
  audience: 'owner' | 'member';
  source: 'vela-preflight' | 'billing-summary' | 'fallback';
  checkedAt: number;
};

export type WorkspaceConcurrencyResult = {
  available: boolean;
  workspaceId: string | null;
  planId: string;
  planLabel: string;
  inFlight: number | null;
  limit: number | null;
  audience: 'owner' | 'member';
  isMaxPlan: boolean;
  checkedAt: number;
};

export function isFreeOrGoPlan(planId?: string | null): boolean {
  const normalized = (planId ?? '').trim().toLowerCase();
  return !normalized || normalized === 'free' || normalized === 'go' || normalized === 'team_free' || normalized === 'team_go';
}

export function isMaxPlanTier(planId?: string | null): boolean {
  const normalized = (planId ?? '').trim().toLowerCase();
  return normalized === 'max' || normalized === 'team_max';
}

export type BillingErrorKind = 'insufficient_balance' | 'tier_limit_exceeded' | 'plan_not_entitled';

export function classifyBillingErrorCode(codeOrMessage?: string | null): BillingErrorKind | null {
  const raw = (codeOrMessage ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (
    lower === 'insufficient_balance'
    || /\binsufficient_balance\b/.test(lower)
    || /balance is too low/.test(lower)
    || /top up,?\s*then try again/.test(lower)
    || /credits? .*exhausted|credits? .*depleted/.test(lower)
  ) {
    return 'insufficient_balance';
  }
  if (
    lower === 'tier_limit_exceeded'
    || /\btier_limit_exceeded\b/.test(lower)
    || /rate or concurrency limit reached|concurrency limit/.test(lower)
  ) {
    return 'tier_limit_exceeded';
  }
  if (
    lower === 'tier_model_not_entitled'
    || lower === 'tier_request_kind_not_entitled'
    || lower === 'model_access_denied'
    || /\b(tier_model_not_entitled|tier_request_kind_not_entitled|model_access_denied)\b/.test(lower)
    || /plan does not include this model|requires opendesign plus/.test(lower)
  ) {
    return 'plan_not_entitled';
  }
  return null;
}

/**
 * Registered OpenMotion entry source recognized by OpenDesign AMR attribution.
 * Unregistered `od_entry_source` values are dropped by AMR along with `od_entry_id`;
 * individual collaboration entry points are distinguished via `utm_medium`.
 */
export const OPENMOTION_CLOUD_ENTRY_SOURCE = 'openmotion_manage_subscription';

export const CLOUD_DESTINATION_UTM_MEDIUM: Record<WorkspaceCloudDestination, string> = {
  plans: 'workspace_plans',
  billing: 'workspace_billing',
  'billing-recovery': 'workspace_billing_recovery',
  members: 'workspace_members',
  'workspace-settings': 'workspace_settings',
  'create-workspace': 'workspace_create',
  referral: 'workspace_referral',
};

const CLOUD_INTENT_PATH_PATTERN =
  /^\/(?:dashboard|billing|settings|account|team|wallet|billing-records|usage-records|subscription|workspace|api-keys|usage)(?:\/|$)/;

export function isCloudIntentTargetPath(pathname: string): boolean {
  const clean = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return CLOUD_INTENT_PATH_PATTERN.test(clean);
}

export function cloudDashboardTargetPath(
  destination: WorkspaceCloudDestination,
  workspaceId?: string | null,
  options?: { expectedAppUserId?: string | null },
): string {
  const ws = workspaceId?.trim() || '';
  const buildPath = (base: string, extraParams: Record<string, string | undefined> = {}) => {
    const params = new URLSearchParams();
    if (ws) params.set('workspaceId', ws);
    for (const [key, value] of Object.entries(extraParams)) {
      if (value) params.set(key, value);
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };

  switch (destination) {
    case 'plans':
      return buildPath('/dashboard', { billing: 'plan' });
    case 'billing':
      return buildPath('/dashboard');
    case 'billing-recovery':
      return buildPath('/dashboard', { billing: 'plan' });
    case 'members':
      return buildPath('/team');
    case 'workspace-settings':
      return buildPath('/settings');
    case 'create-workspace':
      return buildPath('/dashboard', { workspace: 'create' });
    case 'referral': {
      const params = new URLSearchParams({ entry_source: 'client_entry' });
      const expectedAppUserId = options?.expectedAppUserId?.trim();
      if (expectedAppUserId) params.set('expectedAppUserId', expectedAppUserId);
      return `/reset?${params.toString()}`;
    }
  }
}
