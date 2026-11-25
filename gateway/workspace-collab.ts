import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AccountSummary } from '../shared/provider-directory.ts';
import {
  buildWorkspacePermissions,
  CLOUD_DESTINATION_UTM_MEDIUM,
  cloudDashboardTargetPath,
  EMPTY_WORKSPACE_PERMISSIONS,
  formatPlanLabel,
  isMaxPlanTier,
  isValidInviteEmail,
  OPENMOTION_CLOUD_ENTRY_SOURCE,
  workspaceBillingStates,
  workspaceLifecycleStates,
  workspaceMemberRoles,
  workspaceMemberStatuses,
  type CommentSyncState,
  type ProjectCollabMeta,
  type ProjectVisibility,
  type WorkspaceBillingQuota,
  type WorkspaceBillingState,
  type WorkspaceCloudDestination,
  type WorkspaceCollabPreferences,
  type WorkspaceCollabSnapshot,
  type WorkspaceConcurrencyResult,
  type WorkspaceDirectoryEntry,
  type WorkspaceInviteRowInput,
  type WorkspaceInviteRowResult,
  type WorkspaceLifecycleState,
  type WorkspaceMemberEntry,
  type WorkspaceMemberRole,
  type WorkspaceMembersResponse,
  type WorkspaceMemberStatus,
  type WorkspacePreflightReason,
  type WorkspacePreflightResult,
  type WorkspaceProjectKind,
  type WorkspaceReferralSummary,
  type WorkspaceRemovalInfo,
} from '../shared/workspace-collab.ts';
import type { Fetcher } from './network.ts';
import { readSettings, writeSettings } from './settings-storage.ts';

export interface WorkspaceCollabAccountClient {
  readonly root: string;
  summary(refresh?: boolean): Promise<AccountSummary>;
  getControlSession(): Promise<{
    apiUrl: string;
    controlKey: string;
    controlKeyId?: string;
    user?: { id?: string; name?: string; email?: string };
  } | null>;
  listAllWorkspaceRecords(signal?: AbortSignal): Promise<Record<string, unknown>[]>;
  run(args: string[], signal?: AbortSignal, envOverrides?: Record<string, string>): Promise<string>;
  openCloudUrl(
    targetPath: string,
    entrySource?: string,
    launch?: ((url: string) => Promise<void>) | false,
    attribution?: { utmMedium?: string },
  ): Promise<{ url: string; opened: boolean }>;
}

type PersistedWorkspaceMeta = {
  workspaceId: string;
  workspaceName: string;
  workspaceType: 'personal' | 'team';
};

type StoredCollabState = {
  schemaVersion: 1;
  activeWorkspaceId?: string;
  lastWorkspace?: PersistedWorkspaceMeta;
  projectMeta?: Record<string, ProjectCollabMeta>;
  commentSync?: Record<string, WorkspaceCollabSnapshot['commentSync'][string]>;
  preferences?: Partial<WorkspaceCollabPreferences>;
};

const VALID_ROLES = new Set<string>(workspaceMemberRoles);
const VALID_MEMBER_STATUSES = new Set<string>(workspaceMemberStatuses);
const VALID_LIFECYCLE = new Set<string>(workspaceLifecycleStates);
const VALID_BILLING = new Set<string>(workspaceBillingStates);

const INVITE_ERROR_MESSAGES: Record<string, string> = {
  already_member: 'Already a member of this workspace.',
  invite_already_pending: 'An invitation is already pending for this email.',
  forbidden: 'You do not have permission to send this invitation.',
  workspace_locked: 'This workspace is locked. Restore billing before inviting teammates.',
  delivery_pending: 'Email delivery is delayed. Please retry shortly.',
  delivery_failed: 'Could not deliver the invitation email. Retry or verify the address.',
  invalid_email: 'Enter a valid email address.',
  duplicate_email: 'Duplicate email in this batch.',
};

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBillingState(rawBilling: unknown, lifecycle: WorkspaceLifecycleState): WorkspaceBillingState {
  const candidate = str(rawBilling).toLowerCase();
  if (VALID_BILLING.has(candidate)) return candidate as WorkspaceBillingState;
  if (lifecycle === 'locked') return 'locked';
  if (lifecycle === 'billing_past_due') return 'past_due';
  return 'free';
}

function mapWorkspaceRecord(raw: Record<string, unknown>): WorkspaceDirectoryEntry | null {
  const workspaceId = str(raw.workspaceId);
  if (!workspaceId) return null;
  const workspaceName = str(raw.workspaceName) || 'Workspace';
  const workspaceType = raw.workspaceType === 'team' ? 'team' : 'personal';
  const workspaceMemberId = str(raw.workspaceMemberId) || workspaceId;
  const roleCandidate = str(raw.role).toLowerCase();
  const role: WorkspaceMemberRole = VALID_ROLES.has(roleCandidate)
    ? (roleCandidate as WorkspaceMemberRole)
    : 'owner';
  const memberStatusCandidate = str(raw.memberStatus).toLowerCase();
  const memberStatus: WorkspaceMemberStatus = VALID_MEMBER_STATUSES.has(memberStatusCandidate)
    ? (memberStatusCandidate as WorkspaceMemberStatus)
    : 'active';
  const lifecycleCandidate = str(raw.lifecycleState).toLowerCase();
  const lifecycleState: WorkspaceLifecycleState = VALID_LIFECYCLE.has(lifecycleCandidate)
    ? (lifecycleCandidate as WorkspaceLifecycleState)
    : 'active';
  const billingState = normalizeBillingState(raw.billingState, lifecycleState);
  const planId = str(raw.planId || raw.membershipTier) || null;
  const memberCount =
    typeof raw.memberCount === 'number' && Number.isSafeInteger(raw.memberCount) && raw.memberCount > 0
      ? raw.memberCount
      : undefined;

  return {
    workspaceId,
    workspaceName,
    workspaceType,
    workspaceMemberId,
    role,
    isDefault: Boolean(raw.isDefault),
    memberStatus,
    lifecycleState,
    billingState,
    planId,
    ...(memberCount !== undefined ? { memberCount } : {}),
  };
}

function formatUsdAmount(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2);
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const num = Number(value.trim());
    return Number.isFinite(num) ? num.toFixed(2) : null;
  }
  return null;
}

function parseWeeklyWindowFromArray(windowsRaw: unknown): {
  weeklyPercentLeft: number | null;
  weeklyResetsAt: string | null;
} {
  if (!Array.isArray(windowsRaw) || windowsRaw.length === 0) {
    return { weeklyPercentLeft: null, weeklyResetsAt: null };
  }
  const typed = windowsRaw.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  const preferred =
    typed.find(item => item.kind === '7d') ??
    typed.find(item => typeof item.durationSeconds === 'number' && item.durationSeconds >= 5 * 86_400) ??
    typed[0];
  if (!preferred) return { weeklyPercentLeft: null, weeklyResetsAt: null };

  const limitRaw = Number(preferred.limitCredits ?? 0);
  const remainingRaw = Number(preferred.remainingCredits ?? 0);
  const weeklyPercentLeft =
    Number.isFinite(limitRaw) && limitRaw > 0 && Number.isFinite(remainingRaw)
      ? Math.max(0, Math.min(100, Math.round((remainingRaw / limitRaw) * 100)))
      : null;
  const resetsAt = typeof preferred.resetsAt === 'string' && preferred.resetsAt.trim() ? preferred.resetsAt.trim() : null;
  return { weeklyPercentLeft, weeklyResetsAt: resetsAt };
}

function defaultWorkspace(entries: WorkspaceDirectoryEntry[]): WorkspaceDirectoryEntry | null {
  if (!entries.length) return null;
  return (
    entries.find(item => item.workspaceType === 'personal' && item.isDefault) ??
    entries.find(item => item.workspaceType === 'personal') ??
    entries.find(item => item.isDefault) ??
    entries[0]
  );
}

export type RemoteTeamProjectInfo = {
  projectId: string;
  ownerMemberId?: string;
  displayName?: string;
  visibility?: ProjectVisibility;
  updatedAt?: number;
};

const TEAM_PROJECTS_CACHE_TTL_MS = 15_000;

export class WorkspaceCollabService {
  private readonly account: WorkspaceCollabAccountClient;
  private readonly fetcher: Fetcher;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private teamProjectsCache = new Map<string, { expiresAt: number; items: Map<string, RemoteTeamProjectInfo> }>();

  constructor(account: WorkspaceCollabAccountClient, options: { fetcher?: Fetcher } = {}) {
    this.account = account;
    this.fetcher = options.fetcher ?? fetch;
  }

  private get statePath(): string {
    return path.join(this.account.root, 'workspace-collab.json');
  }

  private async readState(): Promise<StoredCollabState> {
    const raw = await readSettings<Partial<StoredCollabState>>(this.statePath, {});
    return {
      schemaVersion: 1,
      ...(typeof raw.activeWorkspaceId === 'string' ? { activeWorkspaceId: raw.activeWorkspaceId } : {}),
      ...(raw.lastWorkspace && typeof raw.lastWorkspace === 'object' ? { lastWorkspace: raw.lastWorkspace } : {}),
      projectMeta: raw.projectMeta && typeof raw.projectMeta === 'object' ? raw.projectMeta : {},
      commentSync: raw.commentSync && typeof raw.commentSync === 'object' ? raw.commentSync : {},
      preferences: {
        skipMoveToTeamConfirm: Boolean(raw.preferences?.skipMoveToTeamConfirm),
        skipRemoveFromTeamConfirm: Boolean(raw.preferences?.skipRemoveFromTeamConfirm),
        dismissedBanners: Array.isArray(raw.preferences?.dismissedBanners)
          ? raw.preferences!.dismissedBanners.filter((item): item is string => typeof item === 'string')
          : [],
      },
    };
  }

  private updateState<T>(updater: (current: StoredCollabState) => Promise<T> | T): Promise<T> {
    const task = this.writeQueue
      .catch(() => {})
      .then(async () => {
        const current = await this.readState();
        const result = await updater(current);
        await writeSettings(this.statePath, current);
        return result;
      });
    this.writeQueue = task;
    return task;
  }

  async getActiveWorkspaceId(): Promise<string | null> {
    const state = await this.readState();
    return state.activeWorkspaceId ?? null;
  }

  private async resolveQuota(
    workspace: WorkspaceDirectoryEntry,
    session: NonNullable<Awaited<ReturnType<WorkspaceCollabAccountClient['getControlSession']>>>,
    accountSummary: AccountSummary,
  ): Promise<WorkspaceBillingQuota> {
    let planId = workspace.planId ?? accountSummary.plan ?? 'free';
    let billingState = workspace.billingState;
    let creditsUsd = formatUsdAmount(accountSummary.balance);
    let weeklyPercentLeft: number | null = null;
    let weeklyResetsAt: string | null = null;
    let unavailable = Boolean(accountSummary.billingUnavailable);

    // 1. Prefer Vela's atomic workspace-scoped snapshot.
    try {
      const stdout = await this.account.run([
        'billing',
        'workspace-snapshot',
        '--workspace-id',
        workspace.workspaceId,
        '--format',
        'json',
      ]);
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      if (parsed && parsed.workspaceId === workspace.workspaceId) {
        const billingObj = parsed.billing && typeof parsed.billing === 'object'
          ? (parsed.billing as Record<string, unknown>)
          : undefined;
        const walletObj = parsed.wallet && typeof parsed.wallet === 'object'
          ? (parsed.wallet as Record<string, unknown>)
          : undefined;
        if (billingObj) {
          const snapshotPlan = str(billingObj.planId);
          if (snapshotPlan) planId = snapshotPlan;
          billingState = normalizeBillingState(billingObj.billingState, workspace.lifecycleState);
        }
        if (walletObj) {
          const parsedCredits = formatUsdAmount(walletObj.balanceUsd);
          if (parsedCredits !== null) creditsUsd = parsedCredits;
        }
        const parsedWindows = parseWeeklyWindowFromArray(parsed.designPlanWindows);
        if (parsedWindows.weeklyPercentLeft !== null) {
          weeklyPercentLeft = parsedWindows.weeklyPercentLeft;
          weeklyResetsAt = parsedWindows.weeklyResetsAt;
        }
        unavailable = false;
      }
    } catch {
      // Fallback to direct authenticated workspace billing API below.
    }

    // 2. Fallback / supplement via authenticated HTTP endpoint when CLI snapshot is unavailable.
    if (weeklyPercentLeft === null || creditsUsd === null) {
      try {
        const summaryUrl = new URL('/api/v1/billing/summary', session.apiUrl);
        summaryUrl.searchParams.set('workspaceId', workspace.workspaceId);
        const response = await this.fetcher(summaryUrl.href, {
          headers: { authorization: `Bearer ${session.controlKey}`, accept: 'application/json' },
          signal: AbortSignal.timeout(8_000),
          redirect: 'error',
        });
        if (response.ok) {
          const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
          if (data) {
            const tier = str(data.membershipTier || data.planId);
            if (tier) planId = tier;
            if (data.billingState !== undefined) {
              billingState = normalizeBillingState(data.billingState, workspace.lifecycleState);
            }
            const nextUsd = formatUsdAmount(data.totalAvailableCreditsUsd ?? data.balanceUsd);
            if (nextUsd !== null) creditsUsd = nextUsd;
            if (typeof data.weeklyPercentLeft === 'number' && Number.isFinite(data.weeklyPercentLeft)) {
              weeklyPercentLeft = Math.max(0, Math.min(100, Math.round(data.weeklyPercentLeft)));
            }
            if (typeof data.weeklyResetsAt === 'string' && data.weeklyResetsAt.trim()) {
              weeklyResetsAt = data.weeklyResetsAt.trim();
            }
            if (weeklyPercentLeft === null && Array.isArray(data.designPlanWindows)) {
              const win = parseWeeklyWindowFromArray(data.designPlanWindows);
              weeklyPercentLeft = win.weeklyPercentLeft;
              weeklyResetsAt = win.weeklyResetsAt;
            }
            unavailable = false;
          }
        }
      } catch {
        // Keep whatever summary / account fields we already have.
      }
    }

    const creditsNum = creditsUsd !== null ? Number(creditsUsd) : null;
    const creditsExhausted = creditsNum !== null && creditsNum <= 0;
    const weeklyLimitExhausted = weeklyPercentLeft !== null && weeklyPercentLeft <= 0;
    const locked = workspace.lifecycleState === 'locked' || workspace.lifecycleState === 'deleted';
    const hasAvailableFunds =
      !locked &&
      (!unavailable
        ? (creditsNum !== null && creditsNum > 0) || (weeklyPercentLeft !== null && weeklyPercentLeft > 0)
        : true);

    return {
      workspaceId: workspace.workspaceId,
      planId: planId || 'free',
      planLabel: formatPlanLabel(planId || 'free'),
      billingState,
      lifecycleState: workspace.lifecycleState,
      weeklyPercentLeft,
      weeklyResetsAt,
      weeklyLimitExhausted,
      creditsUsd,
      creditsExhausted,
      hasAvailableFunds,
      ...(unavailable ? { unavailable: true } : {}),
    };
  }

  private async resolveReferral(
    session: NonNullable<Awaited<ReturnType<WorkspaceCollabAccountClient['getControlSession']>>>,
    consoleBase: string,
  ): Promise<WorkspaceReferralSummary> {
    const params = new URLSearchParams({ entry_source: 'client_entry' });
    if (session.user?.id) params.set('expectedAppUserId', session.user.id);
    const fallbackUrl = `${consoleBase.replace(/\/$/, '')}/reset?${params.toString()}`;
    try {
      const response = await this.fetcher(new URL('/api/v1/referrals/me', session.apiUrl).href, {
        headers: { authorization: `Bearer ${session.controlKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
        redirect: 'error',
      });
      if (!response.ok) {
        return {
          available: true,
          referralUrl: fallbackUrl,
          referralCode: null,
          resetCardsAvailable: 0,
          invitedCount: 0,
          inviteTarget: 5,
          inviteeWindowActive: false,
          inviteeWindowEndsAt: null,
        };
      }
      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const code = str(data?.referralCode || data?.code) || null;
      const rawUrl = str(data?.referralUrl || data?.shareUrl);
      const resetCardsAvailable =
        typeof data?.resetCardsAvailable === 'number' && Number.isFinite(data.resetCardsAvailable)
          ? Math.max(0, Math.floor(data.resetCardsAvailable))
          : 0;
      const invitedCount =
        typeof data?.invitedCount === 'number' && Number.isFinite(data.invitedCount)
          ? Math.max(0, Math.floor(data.invitedCount))
          : 0;
      const inviteTarget =
        typeof data?.inviteTarget === 'number' && Number.isFinite(data.inviteTarget) && data.inviteTarget > 0
          ? Math.floor(data.inviteTarget)
          : 5;
      const inviteeWindowEndsAt =
        typeof data?.inviteeWindowEndsAt === 'string' && data.inviteeWindowEndsAt.trim()
          ? data.inviteeWindowEndsAt.trim()
          : null;
      const inviteeWindowActive =
        typeof data?.inviteeWindowActive === 'boolean'
          ? data.inviteeWindowActive
          : Boolean(inviteeWindowEndsAt && Date.parse(inviteeWindowEndsAt) > Date.now());
      let referralUrl = rawUrl;
      if (!referralUrl) {
        if (code) {
          const parsedUrl = new URL(fallbackUrl);
          parsedUrl.searchParams.set('code', code);
          referralUrl = parsedUrl.toString();
        } else {
          referralUrl = fallbackUrl;
        }
      }
      return {
        available: true,
        referralUrl,
        referralCode: code,
        resetCardsAvailable,
        invitedCount,
        inviteTarget,
        inviteeWindowActive,
        inviteeWindowEndsAt,
      };
    } catch {
      return {
        available: true,
        referralUrl: fallbackUrl,
        referralCode: null,
        resetCardsAvailable: 0,
        invitedCount: 0,
        inviteTarget: 5,
        inviteeWindowActive: false,
        inviteeWindowEndsAt: null,
      };
    }
  }

  async getSnapshot(options: { refresh?: boolean } = {}): Promise<WorkspaceCollabSnapshot> {
    const accountSummary = await this.account.summary(options.refresh === true);
    const stored = await this.readState();
    const preferences: WorkspaceCollabPreferences = {
      skipMoveToTeamConfirm: Boolean(stored.preferences?.skipMoveToTeamConfirm),
      skipRemoveFromTeamConfirm: Boolean(stored.preferences?.skipRemoveFromTeamConfirm),
      dismissedBanners: stored.preferences?.dismissedBanners ?? [],
    };
    const projectMeta = stored.projectMeta ?? {};
    const commentSync = stored.commentSync ?? {};

    if (accountSummary.state !== 'signed-in') {
      return {
        signedIn: false,
        accountState: accountSummary.state,
        workspaces: [],
        activeWorkspaceId: null,
        activeWorkspace: null,
        permissions: EMPTY_WORKSPACE_PERMISSIONS,
        removedFromWorkspace: null,
        quota: null,
        referral: null,
        projectMeta,
        commentSync,
        preferences,
      };
    }

    const session = await this.account.getControlSession();
    if (!session) {
      return {
        signedIn: false,
        accountState: accountSummary.state,
        workspaces: [],
        activeWorkspaceId: null,
        activeWorkspace: null,
        permissions: EMPTY_WORKSPACE_PERMISSIONS,
        removedFromWorkspace: null,
        quota: null,
        referral: null,
        projectMeta,
        commentSync,
        preferences,
      };
    }

    const rawRecords = await this.account.listAllWorkspaceRecords().catch(() => []);
    const allEntries = rawRecords
      .map(mapWorkspaceRecord)
      .filter((item): item is WorkspaceDirectoryEntry => Boolean(item));
    const visibleEntries = allEntries.filter(
      item => item.memberStatus !== 'removed' && item.lifecycleState !== 'deleted',
    );

    let removedFromWorkspace: WorkspaceRemovalInfo | null = null;
    const savedActiveId = stored.activeWorkspaceId?.trim();
    if (savedActiveId) {
      const removedMatch = allEntries.find(
        item => item.workspaceId === savedActiveId && item.memberStatus === 'removed',
      );
      if (removedMatch) {
        removedFromWorkspace = {
          workspaceId: removedMatch.workspaceId,
          workspaceName: removedMatch.workspaceName,
        };
      } else if (
        allEntries.length > 0 &&
        !visibleEntries.some(item => item.workspaceId === savedActiveId) &&
        stored.lastWorkspace?.workspaceId === savedActiveId &&
        stored.lastWorkspace.workspaceType === 'team'
      ) {
        removedFromWorkspace = {
          workspaceId: stored.lastWorkspace.workspaceId,
          workspaceName: stored.lastWorkspace.workspaceName,
        };
      }
    }

    let activeWorkspace: WorkspaceDirectoryEntry | null =
      (savedActiveId ? visibleEntries.find(item => item.workspaceId === savedActiveId) : undefined) ?? null;

    if (!activeWorkspace) {
      activeWorkspace = defaultWorkspace(visibleEntries);
      if (!activeWorkspace && visibleEntries.length === 0) {
        // Fallback synthetic personal entry if workspace directory API returned empty for a signed-in user.
        activeWorkspace = {
          workspaceId: session.user?.id || 'personal',
          workspaceName: session.user?.name ? `${session.user.name}'s workspace` : 'Personal workspace',
          workspaceType: 'personal',
          workspaceMemberId: session.user?.id || 'self',
          role: 'owner',
          isDefault: true,
          memberStatus: 'active',
          lifecycleState: 'active',
          billingState: normalizeBillingState(accountSummary.plan, 'active'),
          planId: accountSummary.plan ?? 'free',
        };
      }
    }

    const workspaces = visibleEntries.length ? visibleEntries : activeWorkspace ? [activeWorkspace] : [];
    const activeWorkspaceId = activeWorkspace?.workspaceId ?? null;

    if (activeWorkspace && !removedFromWorkspace) {
      if (
        stored.activeWorkspaceId !== activeWorkspace.workspaceId ||
        stored.lastWorkspace?.workspaceId !== activeWorkspace.workspaceId ||
        stored.lastWorkspace?.workspaceName !== activeWorkspace.workspaceName
      ) {
        await this.updateState(current => {
          current.activeWorkspaceId = activeWorkspace!.workspaceId;
          current.lastWorkspace = {
            workspaceId: activeWorkspace!.workspaceId,
            workspaceName: activeWorkspace!.workspaceName,
            workspaceType: activeWorkspace!.workspaceType,
          };
        });
      }
    }

    const permissions = activeWorkspace
      ? buildWorkspacePermissions({
          workspaceType: activeWorkspace.workspaceType,
          role: activeWorkspace.role,
          lifecycleState: activeWorkspace.lifecycleState,
          memberStatus: activeWorkspace.memberStatus,
        })
      : EMPTY_WORKSPACE_PERMISSIONS;

    const [quota, referral] = await Promise.all([
      activeWorkspace
        ? this.resolveQuota(activeWorkspace, session, accountSummary)
        : Promise.resolve(null),
      this.resolveReferral(session, accountSummary.consoleUrl),
    ]);

    return {
      signedIn: true,
      accountState: accountSummary.state,
      user: accountSummary.user,
      workspaces,
      activeWorkspaceId,
      activeWorkspace,
      permissions,
      removedFromWorkspace,
      quota,
      referral,
      projectMeta,
      commentSync,
      preferences,
    };
  }

  async switchWorkspace(workspaceId: string): Promise<WorkspaceCollabSnapshot> {
    const cleanId = workspaceId.trim();
    if (!cleanId) throw new Error('Workspace ID is required');
    const rawRecords = await this.account.listAllWorkspaceRecords();
    const target = rawRecords
      .map(mapWorkspaceRecord)
      .find(
        item =>
          item?.workspaceId === cleanId &&
          item.memberStatus !== 'removed' &&
          item.lifecycleState !== 'deleted',
      );
    if (!target) {
      throw new Error('Selected workspace is unavailable or no longer accessible');
    }
    await this.updateState(current => {
      current.activeWorkspaceId = target.workspaceId;
      current.lastWorkspace = {
        workspaceId: target.workspaceId,
        workspaceName: target.workspaceName,
        workspaceType: target.workspaceType,
      };
    });
    return this.getSnapshot({ refresh: true });
  }

  async recoverToPersonalWorkspace(): Promise<WorkspaceCollabSnapshot> {
    const rawRecords = await this.account.listAllWorkspaceRecords().catch(() => []);
    const entries = rawRecords
      .map(mapWorkspaceRecord)
      .filter(
        (item): item is WorkspaceDirectoryEntry =>
          Boolean(item && item.memberStatus !== 'removed' && item.lifecycleState !== 'deleted'),
      );
    const personal = defaultWorkspace(entries);
    await this.updateState(current => {
      if (personal) {
        current.activeWorkspaceId = personal.workspaceId;
        current.lastWorkspace = {
          workspaceId: personal.workspaceId,
          workspaceName: personal.workspaceName,
          workspaceType: personal.workspaceType,
        };
      } else {
        delete current.activeWorkspaceId;
        delete current.lastWorkspace;
      }
    });
    return this.getSnapshot({ refresh: true });
  }

  async inviteMembers(
    workspaceId: string | undefined,
    rows: WorkspaceInviteRowInput[],
  ): Promise<{ workspaceId: string; results: WorkspaceInviteRowResult[] }> {
    const session = await this.account.getControlSession();
    if (!session) throw new Error('Sign in with OpenDesign before inviting teammates');
    const snapshot = await this.getSnapshot();
    const target =
      (workspaceId?.trim()
        ? snapshot.workspaces.find(item => item.workspaceId === workspaceId.trim())
        : snapshot.activeWorkspace) ?? null;
    if (!target) throw new Error('Workspace not found');
    const perms = buildWorkspacePermissions(target);
    if (!perms.canInviteMembers || target.workspaceType !== 'team') {
      throw new Error('You do not have permission to invite teammates to this workspace');
    }
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 20) {
      throw new Error('Provide between 1 and 20 invitation rows');
    }

    const seen = new Set<string>();
    const results: WorkspaceInviteRowResult[] = [];

    for (const row of rows) {
      const email = str(row.email).toLowerCase();
      const role: 'member' | 'admin' = row.role === 'admin' ? 'admin' : 'member';
      if (!isValidInviteEmail(email)) {
        results.push({ email, role, ok: false, error: 'invalid_email', message: INVITE_ERROR_MESSAGES.invalid_email });
        continue;
      }
      if (seen.has(email)) {
        results.push({ email, role, ok: false, error: 'duplicate_email', message: INVITE_ERROR_MESSAGES.duplicate_email });
        continue;
      }
      seen.add(email);

      if (role === 'admin' && !perms.canInviteAdmins) {
        results.push({ email, role, ok: false, error: 'forbidden', message: INVITE_ERROR_MESSAGES.forbidden });
        continue;
      }

      const idempotencyKey = str(row.idempotencyKey) || randomUUID();
      try {
        const endpoint = new URL(
          `/api/v1/workspaces/${encodeURIComponent(target.workspaceId)}/invites`,
          session.apiUrl,
        );
        const response = await this.fetcher(endpoint.href, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.controlKey}`,
            'content-type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ invitedEmail: email, role }),
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!response.ok) {
          const code = str(body?.code || body?.error).toLowerCase() || `create_${response.status}`;
          results.push({
            email,
            role,
            ok: false,
            error: code,
            message: INVITE_ERROR_MESSAGES[code] ?? 'Could not send invitation. Please retry.',
          });
          continue;
        }
        const inviteId = str(body?.inviteId || body?.id);
        const deliveryStatus = str(body?.deliveryStatus).toLowerCase();
        if (deliveryStatus === 'pending' || deliveryStatus === 'delivery_failed') {
          results.push({
            email,
            role,
            ok: false,
            error: deliveryStatus,
            message: INVITE_ERROR_MESSAGES[deliveryStatus],
          });
          continue;
        }
        if (!inviteId) {
          results.push({
            email,
            role,
            ok: false,
            error: 'invalid_response',
            message: 'Unexpected server response. Please retry.',
          });
          continue;
        }
        results.push({ email, role, ok: true, inviteId });
      } catch {
        results.push({
          email,
          role,
          ok: false,
          error: 'network_error',
          message: 'Network error while sending invitation. Please retry.',
        });
      }
    }

    return { workspaceId: target.workspaceId, results };
  }

  async openCloudDestination(
    destination: WorkspaceCloudDestination,
    workspaceId?: string,
    options?: { launch?: boolean },
  ): Promise<{ url: string; opened: boolean }> {
    const activeId = workspaceId?.trim() || (await this.getActiveWorkspaceId());
    const session = destination === 'referral' ? await this.account.getControlSession().catch(() => null) : null;
    const targetPath = cloudDashboardTargetPath(destination, activeId, {
      expectedAppUserId: session?.user?.id,
    });
    return this.account.openCloudUrl(
      targetPath,
      OPENMOTION_CLOUD_ENTRY_SOURCE,
      options?.launch === false ? false : undefined,
      { utmMedium: CLOUD_DESTINATION_UTM_MEDIUM[destination] },
    );
  }

  private invalidateTeamProjectsCache(workspaceId?: string): void {
    if (workspaceId) {
      this.teamProjectsCache.delete(workspaceId);
    } else {
      this.teamProjectsCache.clear();
    }
  }

  private async syncVelaTeamProjectsCommand(workspaceId: string, args: string[]): Promise<boolean> {
    try {
      await this.account.run(['team-projects', ...args], undefined, { VELA_WORKSPACE_ID: workspaceId });
      return true;
    } catch {
      return false;
    }
  }

  private normalizeMemberRecord(
    raw: Record<string, unknown>,
    selfMemberId: string,
    sessionUser?: { id?: string; name?: string; email?: string },
  ): WorkspaceMemberEntry | null {
    const memberId = str(raw.workspaceMemberId || raw.memberId || raw.id);
    const userId = str(raw.userId || raw.appUserId) || undefined;
    const email = str(raw.email || raw.userEmail) || undefined;
    const name = str(raw.displayName || raw.name || raw.userName) || email || 'Member';
    const roleCandidate = str(raw.role).toLowerCase();
    const role: WorkspaceMemberRole = VALID_ROLES.has(roleCandidate)
      ? (roleCandidate as WorkspaceMemberRole)
      : 'member';
    const statusCandidate = str(raw.status || raw.memberStatus).toLowerCase();
    const status: WorkspaceMemberStatus = VALID_MEMBER_STATUSES.has(statusCandidate)
      ? (statusCandidate as WorkspaceMemberStatus)
      : 'active';
    const idValue = memberId || userId || email;
    if (!idValue) return null;
    const isCurrentUser =
      (Boolean(selfMemberId) && memberId === selfMemberId) ||
      (Boolean(sessionUser?.id) && userId === sessionUser!.id) ||
      (Boolean(sessionUser?.email) && email?.toLowerCase() === sessionUser!.email!.toLowerCase());
    const joinedAt = str(raw.joinedAt || raw.createdAt) || undefined;
    return {
      memberId: idValue,
      ...(userId ? { userId } : {}),
      name,
      ...(email ? { email } : {}),
      role,
      status,
      ...(isCurrentUser ? { isCurrentUser: true } : {}),
      ...(joinedAt ? { joinedAt } : {}),
    };
  }

  /**
   * Read active collaborators for a workspace via Cloud API, Vela CLI, or a clean
   * single-member self fallback when directory endpoints are unavailable.
   */
  async listWorkspaceMembers(workspaceId?: string): Promise<WorkspaceMembersResponse> {
    const snapshot = await this.getSnapshot();
    const requestedId = workspaceId?.trim();
    const target =
      (requestedId ? snapshot.workspaces.find(w => w.workspaceId === requestedId) : snapshot.activeWorkspace) ??
      snapshot.activeWorkspace ??
      null;

    if (!target) {
      return {
        workspaceId: requestedId || 'personal',
        workspaceName: 'Personal',
        workspaceType: 'personal',
        members: [],
        totalCount: 0,
        source: 'fallback',
        canInviteMembers: false,
        canInviteAdmins: false,
        canManageMembersInCloud: false,
      };
    }

    const perms = buildWorkspacePermissions(target);
    const session = snapshot.signedIn ? await this.account.getControlSession().catch(() => null) : null;
    const selfName = session?.user?.name?.trim() || session?.user?.email?.trim() || snapshot.user?.name?.trim() || 'You';
    const selfEmail = session?.user?.email?.trim() || snapshot.user?.email?.trim();
    const selfEntry: WorkspaceMemberEntry = {
      memberId: target.workspaceMemberId,
      ...(session?.user?.id ? { userId: session.user.id } : {}),
      name: selfName,
      ...(selfEmail ? { email: selfEmail } : {}),
      role: target.role,
      status: target.memberStatus,
      isCurrentUser: true,
    };

    const parseRawMembers = (payload: unknown): WorkspaceMemberEntry[] | null => {
      const listRaw = Array.isArray(payload)
        ? payload
        : payload && typeof payload === 'object'
          ? ((payload as Record<string, unknown>).members ?? (payload as Record<string, unknown>).items)
          : null;
      if (!Array.isArray(listRaw)) return null;
      const mapped = listRaw
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map(item => this.normalizeMemberRecord(item, target.workspaceMemberId, session?.user))
        .filter((item): item is WorkspaceMemberEntry => Boolean(item && item.status !== 'removed'));
      const roleOrder: Record<WorkspaceMemberRole, number> = { owner: 0, admin: 1, member: 2 };
      mapped.sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.name.localeCompare(b.name));
      return mapped;
    };

    if (snapshot.signedIn && session && target.workspaceType === 'team') {
      try {
        const endpoint = new URL(
          `/api/v1/workspaces/${encodeURIComponent(target.workspaceId)}/members`,
          session.apiUrl,
        );
        const response = await this.fetcher(endpoint.href, {
          headers: { authorization: `Bearer ${session.controlKey}`, accept: 'application/json' },
          signal: AbortSignal.timeout(8_000),
          redirect: 'error',
        });
        if (response.ok) {
          const payload = await response.json().catch(() => null);
          const parsed = parseRawMembers(payload);
          if (parsed) {
            return {
              workspaceId: target.workspaceId,
              workspaceName: target.workspaceName,
              workspaceType: target.workspaceType,
              members: parsed,
              totalCount: Math.max(parsed.length, target.memberCount ?? parsed.length),
              source: 'cloud_api',
              canInviteMembers: perms.canInviteMembers,
              canInviteAdmins: perms.canInviteAdmins,
              canManageMembersInCloud: perms.canManageWorkspace,
            };
          }
        }
      } catch {
        // Fallback to Vela CLI member directory below.
      }

      try {
        const stdout = await this.account.run(['collab', 'member', 'list'], undefined, {
          VELA_WORKSPACE_ID: target.workspaceId,
        });
        const payload = JSON.parse(stdout);
        const parsed = parseRawMembers(payload);
        if (parsed) {
          return {
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            workspaceType: target.workspaceType,
            members: parsed,
            totalCount: Math.max(parsed.length, target.memberCount ?? parsed.length),
            source: 'vela_cli',
            canInviteMembers: perms.canInviteMembers,
            canInviteAdmins: perms.canInviteAdmins,
            canManageMembersInCloud: perms.canManageWorkspace,
          };
        }
      } catch {
        // Fallback to current user directory entry below.
      }
    }

    const fallbackMembers = snapshot.signedIn ? [selfEntry] : [];
    const fallbackTotal =
      target.workspaceType === 'team'
        ? Math.max(fallbackMembers.length, target.memberCount ?? fallbackMembers.length)
        : fallbackMembers.length;

    return {
      workspaceId: target.workspaceId,
      workspaceName: target.workspaceName,
      workspaceType: target.workspaceType,
      members: fallbackMembers,
      totalCount: fallbackTotal,
      source: 'fallback',
      canInviteMembers: target.workspaceType === 'team' && perms.canInviteMembers,
      canInviteAdmins: target.workspaceType === 'team' && perms.canInviteAdmins,
      canManageMembersInCloud: target.workspaceType === 'team' && perms.canManageWorkspace,
    };
  }

  /**
   * Read the remote Vela team-projects catalog best-effort with short TTL caching.
   */
  async listRemoteTeamProjects(workspaceId: string): Promise<Map<string, RemoteTeamProjectInfo>> {
    const cleanWsId = workspaceId.trim();
    if (!cleanWsId) return new Map();
    const cached = this.teamProjectsCache.get(cleanWsId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.items;
    }
    const items = new Map<string, RemoteTeamProjectInfo>();
    try {
      const stdout = await this.account.run(['team-projects', 'list'], undefined, {
        VELA_WORKSPACE_ID: cleanWsId,
      });
      const parsed = JSON.parse(stdout) as unknown;
      const rows = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).projects)
          ? ((parsed as Record<string, unknown>).projects as unknown[])
          : [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const rec = row as Record<string, unknown>;
        const projectId = str(rec.projectId);
        if (!projectId) continue;
        const rawVis = str(rec.visibility).toLowerCase();
        const visibility: ProjectVisibility | undefined =
          rawVis === 'private' ? 'private' : rawVis === 'team' || rawVis === 'workspace' ? 'workspace' : undefined;
        const ownerMemberId = str(rec.ownerMemberId) || undefined;
        const displayName = str(rec.displayName || rec.name) || undefined;
        const rawUpdated = typeof rec.updatedAt === 'string' ? Date.parse(rec.updatedAt) : Number(rec.updatedAt);
        items.set(projectId, {
          projectId,
          ...(ownerMemberId ? { ownerMemberId } : {}),
          ...(displayName ? { displayName } : {}),
          ...(visibility ? { visibility } : {}),
          ...(Number.isFinite(rawUpdated) && rawUpdated > 0 ? { updatedAt: rawUpdated } : {}),
        });
      }
      this.teamProjectsCache.set(cleanWsId, { expiresAt: Date.now() + TEAM_PROJECTS_CACHE_TTL_MS, items });
    } catch {
      // Offline / CLI unsupported: return empty map cleanly.
    }
    return items;
  }

  async moveProjectToWorkspace(
    projectId: string,
    targetWorkspaceId: string,
    skipFutureConfirm?: boolean,
    options?: { kind?: WorkspaceProjectKind; title?: string },
  ): Promise<WorkspaceCollabSnapshot> {
    const cleanProjectId = projectId.trim();
    const cleanWorkspaceId = targetWorkspaceId.trim();
    if (!cleanProjectId || !cleanWorkspaceId) {
      throw new Error('Project ID and target workspace ID are required');
    }
    const snapshot = await this.getSnapshot();
    const target = snapshot.workspaces.find(item => item.workspaceId === cleanWorkspaceId);
    if (!target || target.workspaceType !== 'team') {
      throw new Error('Choose an active team workspace to move this project into');
    }
    const perms = buildWorkspacePermissions(target);
    if (!perms.canEditWorkspaceContent) {
      throw new Error('Target team workspace is locked or read-only');
    }
    const existingMeta = snapshot.projectMeta[cleanProjectId];
    if (
      existingMeta &&
      existingMeta.workspaceId === target.workspaceId &&
      existingMeta.ownerMemberId &&
      existingMeta.ownerMemberId !== target.workspaceMemberId
    ) {
      throw new Error('This project is owned by another team member');
    }
    const session = await this.account.getControlSession().catch(() => null);
    const ownerName = session?.user?.name?.trim() || session?.user?.email?.trim() || snapshot.user?.name?.trim();
    const upsertArgs = ['upsert', cleanProjectId, '--resource-id', `project-${cleanProjectId}`];
    if (options?.title?.trim()) {
      upsertArgs.push('--display-name', options.title.trim().slice(0, 120));
    }
    const upserted = await this.syncVelaTeamProjectsCommand(target.workspaceId, upsertArgs);
    if (!upserted) {
      throw new Error('Could not sync project to the team workspace. Please retry when connected.');
    }
    const visibilitySynced = await this.syncVelaTeamProjectsCommand(target.workspaceId, [
      'visibility',
      cleanProjectId,
      'team',
    ]);
    if (!visibilitySynced) {
      throw new Error('Could not update project visibility in the team workspace. Please retry when connected.');
    }
    this.invalidateTeamProjectsCache(target.workspaceId);

    await this.updateState(current => {
      current.projectMeta ??= {};
      const prev = current.projectMeta[cleanProjectId];
      const kind = options?.kind ?? prev?.kind;
      current.projectMeta[cleanProjectId] = {
        projectId: cleanProjectId,
        workspaceId: target.workspaceId,
        visibility: 'workspace',
        ...(kind ? { kind } : {}),
        ownerMemberId: target.workspaceMemberId,
        ...(ownerName ? { ownerName } : {}),
        teamSynced: true,
        movedAt: Date.now(),
      };
      if (skipFutureConfirm) {
        current.preferences ??= { skipMoveToTeamConfirm: false, dismissedBanners: [] };
        current.preferences.skipMoveToTeamConfirm = true;
      }
    });
    return this.getSnapshot();
  }

  /**
   * Unshare a project from its team workspace and return it to the creator's Personal workspace.
   */
  async removeProjectFromTeam(projectId: string, skipFutureConfirm?: boolean): Promise<WorkspaceCollabSnapshot> {
    const cleanProjectId = projectId.trim();
    if (!cleanProjectId) {
      throw new Error('Project ID is required');
    }
    const snapshot = await this.getSnapshot();
    const existingMeta = snapshot.projectMeta[cleanProjectId];
    const teamWs = existingMeta
      ? snapshot.workspaces.find(w => w.workspaceId === existingMeta.workspaceId && w.workspaceType === 'team')
      : undefined;
    if (!existingMeta || !teamWs) {
      throw new Error('Project is not shared in a team workspace');
    }
    if (
      existingMeta.ownerMemberId &&
      teamWs.workspaceMemberId &&
      existingMeta.ownerMemberId !== teamWs.workspaceMemberId
    ) {
      throw new Error('Only the project creator can remove this project from the team');
    }
    const perms = buildWorkspacePermissions(teamWs);
    if (!perms.canEditWorkspaceContent) {
      throw new Error('Target team workspace is locked or read-only');
    }

    const removed = await this.syncVelaTeamProjectsCommand(teamWs.workspaceId, ['remove', cleanProjectId]);
    if (!removed) {
      throw new Error('Could not remove project from the team workspace. Please retry when connected.');
    }
    this.invalidateTeamProjectsCache(teamWs.workspaceId);

    const personalWs =
      snapshot.workspaces.find(w => w.workspaceType === 'personal' && w.isDefault) ??
      snapshot.workspaces.find(w => w.workspaceType === 'personal');
    const personalWsId = personalWs?.workspaceId ?? 'personal';
    const session = await this.account.getControlSession().catch(() => null);
    const ownerName = session?.user?.name?.trim() || session?.user?.email?.trim() || existingMeta.ownerName;

    await this.updateState(current => {
      current.projectMeta ??= {};
      const prev = current.projectMeta[cleanProjectId];
      current.projectMeta[cleanProjectId] = {
        projectId: cleanProjectId,
        workspaceId: personalWsId,
        visibility: 'private',
        ...(prev?.kind ? { kind: prev.kind } : {}),
        ...(personalWs?.workspaceMemberId
          ? { ownerMemberId: personalWs.workspaceMemberId }
          : prev?.ownerMemberId
            ? { ownerMemberId: prev.ownerMemberId }
            : {}),
        ...(ownerName ? { ownerName } : {}),
        teamSynced: false,
        removedFromTeamAt: Date.now(),
      };
      if (skipFutureConfirm) {
        current.preferences ??= { skipMoveToTeamConfirm: false, dismissedBanners: [] };
        current.preferences.skipRemoveFromTeamConfirm = true;
      }
    });
    return this.getSnapshot();
  }

  async setProjectVisibility(projectId: string, visibility: ProjectVisibility): Promise<WorkspaceCollabSnapshot> {
    const cleanProjectId = projectId.trim();
    if (!cleanProjectId || (visibility !== 'private' && visibility !== 'workspace')) {
      throw new Error('Valid projectId and visibility are required');
    }
    const snapshot = await this.getSnapshot();
    const prevMeta = snapshot.projectMeta[cleanProjectId];
    const workspaceId = prevMeta?.workspaceId ?? snapshot.activeWorkspaceId ?? 'personal';
    const teamWs = snapshot.workspaces.find(w => w.workspaceId === workspaceId && w.workspaceType === 'team');
    if (teamWs) {
      if (
        prevMeta?.ownerMemberId &&
        teamWs.workspaceMemberId &&
        prevMeta.ownerMemberId !== teamWs.workspaceMemberId
      ) {
        throw new Error('Only the project creator can change visibility');
      }
      const synced = await this.syncVelaTeamProjectsCommand(teamWs.workspaceId, [
        'visibility',
        cleanProjectId,
        visibility === 'workspace' ? 'team' : 'private',
      ]);
      if (!synced) {
        throw new Error('Could not update project visibility in the team workspace. Please retry when connected.');
      }
      this.invalidateTeamProjectsCache(teamWs.workspaceId);
    }

    await this.updateState(current => {
      current.projectMeta ??= {};
      const prev = current.projectMeta[cleanProjectId];
      current.projectMeta[cleanProjectId] = {
        projectId: cleanProjectId,
        workspaceId,
        visibility,
        ...(prev?.kind ? { kind: prev.kind } : {}),
        ...(prev?.ownerMemberId ? { ownerMemberId: prev.ownerMemberId } : {}),
        ...(prev?.ownerName ? { ownerName: prev.ownerName } : {}),
        ...(prev?.teamSynced !== undefined ? { teamSynced: prev.teamSynced } : {}),
        ...(prev?.movedAt ? { movedAt: prev.movedAt } : {}),
        ...(prev?.removedFromTeamAt ? { removedFromTeamAt: prev.removedFromTeamAt } : {}),
      };
    });
    return this.getSnapshot();
  }

  async reportCommentSyncState(
    projectId: string,
    state: CommentSyncState,
    pendingCount = 0,
    lastError?: string,
  ): Promise<WorkspaceCollabSnapshot> {
    const cleanProjectId = projectId.trim();
    if (!cleanProjectId) throw new Error('Project ID is required');
    await this.updateState(current => {
      current.commentSync ??= {};
      current.commentSync[cleanProjectId] = {
        projectId: cleanProjectId,
        state,
        pendingCount: Math.max(0, Math.floor(pendingCount)),
        ...(lastError ? { lastError } : {}),
        updatedAt: Date.now(),
      };
    });
    return this.getSnapshot();
  }

  async retryCommentSync(projectId: string): Promise<WorkspaceCollabSnapshot> {
    const cleanProjectId = projectId.trim();
    if (!cleanProjectId) throw new Error('Project ID is required');
    const session = await this.account.getControlSession();
    if (!session) {
      return this.reportCommentSyncState(
        cleanProjectId,
        'failed',
        (await this.readState()).commentSync?.[cleanProjectId]?.pendingCount ?? 1,
        'Sign in with OpenDesign before syncing review comments.',
      );
    }
    const snapshot = await this.getSnapshot();
    if (!snapshot.permissions.canEditWorkspaceContent) {
      return this.reportCommentSyncState(
        cleanProjectId,
        'failed',
        snapshot.commentSync[cleanProjectId]?.pendingCount ?? 1,
        'Workspace is locked. Restore access before syncing comments.',
      );
    }
    const pendingCount = Math.max(1, snapshot.commentSync[cleanProjectId]?.pendingCount ?? 1);
    return this.reportCommentSyncState(
      cleanProjectId,
      'failed',
      pendingCount,
      'Cloud comment sync is not available yet. Pending comments stay saved locally.',
    );
  }

  async preflightWorkspace(
    options: { model?: string; workspaceId?: string } = {},
  ): Promise<WorkspacePreflightResult> {
    const checkedAt = Date.now();
    const snapshot = await this.getSnapshot({ refresh: true });
    if (!snapshot.signedIn || !snapshot.activeWorkspace) {
      return {
        funded: true,
        reason: 'signed_out',
        workspaceId: null,
        workspaceName: null,
        workspaceType: null,
        planId: 'free',
        planLabel: 'Free',
        balanceUsd: null,
        weeklyPercentLeft: null,
        weeklyResetsAt: null,
        audience: 'owner',
        source: 'fallback',
        checkedAt,
      };
    }

    const requestedId = options.workspaceId?.trim();
    const target =
      (requestedId ? snapshot.workspaces.find(w => w.workspaceId === requestedId) : undefined) ??
      snapshot.activeWorkspace;
    const audience: 'owner' | 'member' =
      target.workspaceId === snapshot.activeWorkspaceId
        ? snapshot.permissions.canManageBilling
          ? 'owner'
          : 'member'
        : target.role === 'owner'
          ? 'owner'
          : 'member';

    let quota = target.workspaceId === snapshot.activeWorkspaceId ? snapshot.quota : null;
    if (!quota) {
      const session = await this.account.getControlSession().catch(() => null);
      if (session) {
        const accountSummary = await this.account.summary(false).catch(() => null);
        if (accountSummary) {
          quota = await this.resolveQuota(target, session, accountSummary).catch(() => null);
        }
      }
    }

    const basePlanId = quota?.planId ?? target.planId ?? 'free';
    const baseFields = {
      workspaceId: target.workspaceId,
      workspaceName: target.workspaceName,
      workspaceType: target.workspaceType,
      planId: basePlanId,
      planLabel: formatPlanLabel(basePlanId),
      balanceUsd: quota?.creditsUsd ?? null,
      weeklyPercentLeft: quota?.weeklyPercentLeft ?? null,
      weeklyResetsAt: quota?.weeklyResetsAt ?? null,
      audience,
      checkedAt,
    };

    if (target.lifecycleState === 'locked') {
      return { ...baseFields, funded: false, reason: 'workspace_locked', source: 'fallback' };
    }
    if (target.lifecycleState === 'billing_past_due') {
      return { ...baseFields, funded: false, reason: 'billing_past_due', source: 'fallback' };
    }

    // 1. Prefer Vela `billing preflight` when available and structured.
    try {
      const args = ['billing', 'preflight', '--workspace-id', target.workspaceId];
      if (options.model?.trim()) args.push('--model', options.model.trim());
      args.push('--format', 'json');
      const stdout = await this.account.run(args);
      const parsed = JSON.parse(stdout) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const billingObj =
          parsed.billing && typeof parsed.billing === 'object' ? (parsed.billing as Record<string, unknown>) : undefined;
        const walletObj =
          parsed.wallet && typeof parsed.wallet === 'object' ? (parsed.wallet as Record<string, unknown>) : undefined;
        const planId =
          str(parsed.planId || parsed.membershipTier || billingObj?.planId || basePlanId) || 'free';
        const balanceUsd =
          formatUsdAmount(parsed.balanceUsd ?? parsed.totalAvailableCreditsUsd ?? walletObj?.balanceUsd) ??
          baseFields.balanceUsd;
        const parsedWin = parseWeeklyWindowFromArray(parsed.designPlanWindows);
        const weeklyPercentLeft =
          typeof parsed.weeklyPercentLeft === 'number' && Number.isFinite(parsed.weeklyPercentLeft)
            ? Math.max(0, Math.min(100, Math.round(parsed.weeklyPercentLeft)))
            : parsedWin.weeklyPercentLeft ?? baseFields.weeklyPercentLeft;
        const weeklyResetsAt = str(parsed.weeklyResetsAt) || parsedWin.weeklyResetsAt || baseFields.weeklyResetsAt;

        const explicitFunded =
          typeof parsed.funded === 'boolean'
            ? parsed.funded
            : typeof parsed.allowed === 'boolean'
              ? parsed.allowed
              : typeof parsed.canRun === 'boolean'
                ? parsed.canRun
                : typeof parsed.ok === 'boolean'
                  ? parsed.ok
                  : null;
        const balanceNum = balanceUsd !== null ? Number(balanceUsd) : null;
        const inferredFunded =
          explicitFunded ??
          (balanceNum !== null || weeklyPercentLeft !== null
            ? (balanceNum !== null && balanceNum > 0) || (weeklyPercentLeft !== null && weeklyPercentLeft > 0)
            : null);

        if (inferredFunded !== null) {
          const rawReason = str(parsed.reason || parsed.errorCode).toLowerCase();
          let reason: WorkspacePreflightReason = inferredFunded ? 'ok' : 'insufficient_balance';
          if (rawReason === 'workspace_locked') reason = 'workspace_locked';
          else if (rawReason === 'billing_past_due') reason = 'billing_past_due';
          else if (
            rawReason === 'plan_not_entitled'
            || rawReason === 'tier_model_not_entitled'
            || rawReason === 'tier_request_kind_not_entitled'
            || rawReason === 'model_access_denied'
          ) {
            reason = 'plan_not_entitled';
          } else if (rawReason === 'insufficient_balance') {
            reason = 'insufficient_balance';
          }

          return {
            funded: inferredFunded,
            reason,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            workspaceType: target.workspaceType,
            planId,
            planLabel: formatPlanLabel(planId),
            balanceUsd,
            weeklyPercentLeft,
            weeklyResetsAt,
            audience,
            source: 'vela-preflight',
            checkedAt,
          };
        }
      }
    } catch {
      // Fallback to billing summary snapshot below.
    }

    // 2. Fallback to billing-summary quota snapshot (fail-open only if billing itself is unavailable).
    if (!quota || quota.unavailable) {
      return { ...baseFields, funded: true, reason: 'unavailable', source: 'fallback' };
    }
    return {
      ...baseFields,
      funded: quota.hasAvailableFunds,
      reason: quota.hasAvailableFunds ? 'ok' : 'insufficient_balance',
      source: 'billing-summary',
    };
  }

  async getRequestConcurrency(workspaceId?: string): Promise<WorkspaceConcurrencyResult> {
    const checkedAt = Date.now();
    const snapshot = await this.getSnapshot({ refresh: false });
    const requestedId = workspaceId?.trim();
    const target =
      (requestedId ? snapshot.workspaces.find(w => w.workspaceId === requestedId) : undefined) ??
      snapshot.activeWorkspace;

    if (!snapshot.signedIn || !target) {
      return {
        available: false,
        workspaceId: null,
        planId: 'free',
        planLabel: 'Free',
        inFlight: null,
        limit: null,
        audience: 'owner',
        isMaxPlan: false,
        checkedAt,
      };
    }

    const audience: 'owner' | 'member' =
      target.workspaceId === snapshot.activeWorkspaceId
        ? snapshot.permissions.canManageBilling
          ? 'owner'
          : 'member'
        : target.role === 'owner'
          ? 'owner'
          : 'member';
    const planId = snapshot.quota?.planId ?? target.planId ?? 'free';
    const base: WorkspaceConcurrencyResult = {
      available: false,
      workspaceId: target.workspaceId,
      planId,
      planLabel: formatPlanLabel(planId),
      inFlight: null,
      limit: null,
      audience,
      isMaxPlan: isMaxPlanTier(planId),
      checkedAt,
    };

    try {
      const stdout = await this.account.run([
        'billing',
        'request-concurrency',
        '--workspace-id',
        target.workspaceId,
        '--format',
        'json',
      ]);
      const parsed = JSON.parse(stdout) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const firstInt = (candidates: unknown[]): number | null => {
          for (const candidate of candidates) {
            if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
              return Math.floor(candidate);
            }
          }
          return null;
        };
        const inFlight = firstInt([
          parsed.inFlight,
          parsed.in_flight,
          parsed.activeRequests,
          parsed.activeCount,
          parsed.current,
        ]);
        const limit = firstInt([
          parsed.limit,
          parsed.maxConcurrency,
          parsed.concurrencyLimit,
          parsed.max_concurrency,
          parsed.max,
        ]);
        if (inFlight !== null || limit !== null) {
          return {
            ...base,
            available: true,
            inFlight,
            limit,
          };
        }
      }
    } catch {
      // Request-concurrency is advisory; fail softly when CLI command is unavailable.
    }

    return base;
  }

  async updatePreferences(patch: {
    skipMoveToTeamConfirm?: boolean;
    skipRemoveFromTeamConfirm?: boolean;
    dismissBanner?: string;
  }): Promise<WorkspaceCollabSnapshot> {
    await this.updateState(current => {
      current.preferences ??= { skipMoveToTeamConfirm: false, dismissedBanners: [] };
      if (typeof patch.skipMoveToTeamConfirm === 'boolean') {
        current.preferences.skipMoveToTeamConfirm = patch.skipMoveToTeamConfirm;
      }
      if (typeof patch.skipRemoveFromTeamConfirm === 'boolean') {
        current.preferences.skipRemoveFromTeamConfirm = patch.skipRemoveFromTeamConfirm;
      }
      if (typeof patch.dismissBanner === 'string' && patch.dismissBanner.trim()) {
        const key = patch.dismissBanner.trim();
        const existing = new Set(current.preferences.dismissedBanners ?? []);
        existing.add(key);
        current.preferences.dismissedBanners = [...existing];
      }
    });
    return this.getSnapshot();
  }
}

const services = new WeakMap<WorkspaceCollabAccountClient, WorkspaceCollabService>();

export function workspaceCollabFor(
  account: WorkspaceCollabAccountClient,
  options?: { fetcher?: Fetcher },
): WorkspaceCollabService {
  let service = services.get(account);
  if (!service) {
    service = new WorkspaceCollabService(account, options);
    services.set(account, service);
  }
  return service;
}
