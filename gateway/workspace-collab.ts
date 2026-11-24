import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AccountSummary } from '../shared/provider-directory.ts';
import {
  buildWorkspacePermissions,
  CLOUD_DESTINATION_UTM_MEDIUM,
  cloudDashboardTargetPath,
  EMPTY_WORKSPACE_PERMISSIONS,
  formatPlanLabel,
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
  type WorkspaceDirectoryEntry,
  type WorkspaceInviteRowInput,
  type WorkspaceInviteRowResult,
  type WorkspaceLifecycleState,
  type WorkspaceMemberRole,
  type WorkspaceMemberStatus,
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

export class WorkspaceCollabService {
  private readonly account: WorkspaceCollabAccountClient;
  private readonly fetcher: Fetcher;
  private writeQueue: Promise<unknown> = Promise.resolve();

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
      return {
        available: true,
        referralUrl: rawUrl || (code ? `${fallbackUrl}?code=${encodeURIComponent(code)}` : fallbackUrl),
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

  async moveProjectToWorkspace(
    projectId: string,
    targetWorkspaceId: string,
    skipFutureConfirm?: boolean,
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
    await this.updateState(current => {
      current.projectMeta ??= {};
      current.projectMeta[cleanProjectId] = {
        projectId: cleanProjectId,
        workspaceId: target.workspaceId,
        visibility: 'workspace',
        movedAt: Date.now(),
      };
      if (skipFutureConfirm) {
        current.preferences ??= {};
        current.preferences.skipMoveToTeamConfirm = true;
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
    const workspaceId =
      snapshot.projectMeta[cleanProjectId]?.workspaceId ?? snapshot.activeWorkspaceId ?? 'personal';
    await this.updateState(current => {
      current.projectMeta ??= {};
      const prev = current.projectMeta[cleanProjectId];
      current.projectMeta[cleanProjectId] = {
        projectId: cleanProjectId,
        workspaceId,
        visibility,
        ...(prev?.movedAt ? { movedAt: prev.movedAt } : {}),
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
    return this.reportCommentSyncState(cleanProjectId, 'synced', 0);
  }

  async updatePreferences(patch: {
    skipMoveToTeamConfirm?: boolean;
    dismissBanner?: string;
  }): Promise<WorkspaceCollabSnapshot> {
    await this.updateState(current => {
      current.preferences ??= { skipMoveToTeamConfirm: false, dismissedBanners: [] };
      if (typeof patch.skipMoveToTeamConfirm === 'boolean') {
        current.preferences.skipMoveToTeamConfirm = patch.skipMoveToTeamConfirm;
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
