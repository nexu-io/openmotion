import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  WorkspaceCollabService,
  type WorkspaceCollabAccountClient,
} from '../gateway/workspace-collab.ts';
import type { AccountSummary } from '../shared/provider-directory.ts';
import {
  buildWorkspacePermissions,
  cloudDashboardTargetPath,
  isCloudIntentTargetPath,
  isValidInviteEmail,
} from '../shared/workspace-collab.ts';

function createMockAccountClient(rootDir: string, options: {
  signedIn?: boolean;
  workspaces?: Record<string, unknown>[];
  velaSnapshot?: Record<string, unknown> | null;
  fetcherResponses?: Array<{ urlMatch: RegExp; method?: string; handler: (url: string, init?: RequestInit) => Promise<Response> | Response }>;
} = {}) {
  let signedIn = options.signedIn ?? true;
  let workspaces = options.workspaces ?? [
    {
      workspaceId: 'ws_personal',
      workspaceName: 'Personal',
      workspaceType: 'personal',
      workspaceMemberId: 'mem_p1',
      role: 'owner',
      isDefault: true,
      memberStatus: 'active',
      lifecycleState: 'active',
      billingState: 'free',
      planId: 'free',
    },
    {
      workspaceId: 'ws_team_1',
      workspaceName: 'Studio Alpha',
      workspaceType: 'team',
      workspaceMemberId: 'mem_t1',
      role: 'owner',
      isDefault: false,
      memberStatus: 'active',
      lifecycleState: 'active',
      billingState: 'active',
      planId: 'plus',
      memberCount: 4,
    },
  ];
  const openedUrls: Array<{ targetPath: string; entrySource?: string; utmMedium?: string }> = [];

  const client: WorkspaceCollabAccountClient = {
    root: rootDir,
    async summary(): Promise<AccountSummary> {
      return signedIn
        ? {
            state: 'signed-in',
            user: { name: 'Eli', email: 'eli@example.com' },
            plan: 'plus',
            balance: '125.85',
            consoleUrl: 'https://open-design.ai/cloud',
          }
        : {
            state: 'signed-out',
            consoleUrl: 'https://open-design.ai/cloud',
          };
    },
    async getControlSession() {
      return signedIn
        ? {
            apiUrl: 'https://amr-api.open-design.ai',
            controlKey: 'ctrl_secret',
            user: { id: 'usr_1', name: 'Eli', email: 'eli@example.com' },
          }
        : null;
    },
    async listAllWorkspaceRecords() {
      return workspaces;
    },
    async run(args) {
      if (args[0] === 'billing' && args[1] === 'workspace-snapshot') {
        if (!options.velaSnapshot) throw new Error('snapshot unsupported');
        return JSON.stringify(options.velaSnapshot);
      }
      throw new Error('unsupported command');
    },
    async openCloudUrl(targetPath, entrySource, _launch, attribution) {
      openedUrls.push({ targetPath, entrySource, utmMedium: attribution?.utmMedium });
      return { url: `https://open-design.ai/cloud${targetPath}`, opened: true };
    },
  };

  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const rule of options.fetcherResponses ?? []) {
      if (rule.urlMatch.test(url) && (!rule.method || rule.method === method)) {
        return rule.handler(url, init);
      }
    }
    if (url.includes('/api/v1/billing/summary')) {
      return new Response(
        JSON.stringify({
          membershipTier: 'plus',
          totalAvailableCreditsUsd: '125.85',
          weeklyPercentLeft: 82,
          weeklyResetsAt: '2026-12-01T00:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/v1/referrals/me')) {
      return new Response(
        JSON.stringify({
          referralCode: 'ELIX5',
          referralUrl: 'https://open-design.ai/cloud/referral?code=ELIX5',
          resetCardsAvailable: 2,
          invitedCount: 2,
          inviteTarget: 5,
          inviteeWindowActive: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  };

  return {
    client,
    fetcher,
    openedUrls,
    setSignedIn(next: boolean) {
      signedIn = next;
    },
    setWorkspaces(next: Record<string, unknown>[]) {
      workspaces = next;
    },
  };
}

test('pure permission helpers and URL builder enforce role boundaries', () => {
  const ownerPerms = buildWorkspacePermissions({
    workspaceType: 'team',
    role: 'owner',
    lifecycleState: 'active',
    memberStatus: 'active',
  });
  assert.deepEqual(ownerPerms, {
    canInviteMembers: true,
    canInviteAdmins: true,
    canManageBilling: true,
    canShowWorkspaceSettings: true,
    canManageWorkspace: true,
    canEditWorkspaceContent: true,
  });

  const adminPerms = buildWorkspacePermissions({
    workspaceType: 'team',
    role: 'admin',
    lifecycleState: 'active',
    memberStatus: 'active',
  });
  assert.equal(adminPerms.canInviteMembers, true);
  assert.equal(adminPerms.canInviteAdmins, false);
  assert.equal(adminPerms.canManageBilling, false);
  assert.equal(adminPerms.canShowWorkspaceSettings, true);

  const memberPerms = buildWorkspacePermissions({
    workspaceType: 'team',
    role: 'member',
    lifecycleState: 'active',
    memberStatus: 'active',
  });
  assert.equal(memberPerms.canInviteMembers, false);
  assert.equal(memberPerms.canManageBilling, false);
  assert.equal(memberPerms.canShowWorkspaceSettings, false);
  assert.equal(memberPerms.canEditWorkspaceContent, true);

  const lockedOwner = buildWorkspacePermissions({
    workspaceType: 'team',
    role: 'owner',
    lifecycleState: 'locked',
    memberStatus: 'active',
  });
  assert.equal(lockedOwner.canInviteMembers, false);
  assert.equal(lockedOwner.canManageBilling, true);
  assert.equal(lockedOwner.canEditWorkspaceContent, false);

  assert.equal(isValidInviteEmail('ada@acme.io'), true);
  assert.equal(isValidInviteEmail('not-an-email'), false);
  assert.equal(cloudDashboardTargetPath('plans', 'ws_team_1'), '/dashboard?workspaceId=ws_team_1&billing=plan');
  assert.equal(cloudDashboardTargetPath('billing', 'ws_team_1'), '/dashboard?workspaceId=ws_team_1');
  assert.equal(cloudDashboardTargetPath('billing-recovery', 'ws_team_1'), '/dashboard?workspaceId=ws_team_1&billing=plan');
  assert.equal(cloudDashboardTargetPath('members', 'ws_team_1'), '/team?workspaceId=ws_team_1');
  assert.equal(cloudDashboardTargetPath('workspace-settings', 'ws_team_1'), '/settings?workspaceId=ws_team_1');
  assert.equal(cloudDashboardTargetPath('create-workspace', 'ws_team_1'), '/dashboard?workspaceId=ws_team_1&workspace=create');
  assert.equal(cloudDashboardTargetPath('referral', 'ws_team_1'), '/reset?entry_source=client_entry');
  assert.equal(
    cloudDashboardTargetPath('referral', 'ws_team_1', { expectedAppUserId: 'usr_1' }),
    '/reset?entry_source=client_entry&expectedAppUserId=usr_1',
  );
  assert.equal(isCloudIntentTargetPath('/dashboard'), true);
  assert.equal(isCloudIntentTargetPath('/team'), true);
  assert.equal(isCloudIntentTargetPath('/settings'), true);
  assert.equal(isCloudIntentTargetPath('/reset'), false);
});

test('signed-out snapshot degrades cleanly without errors', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'om-collab-test-'));
  try {
    const mock = createMockAccountClient(dir, { signedIn: false });
    const service = new WorkspaceCollabService(mock.client, { fetcher: mock.fetcher });
    const snap = await service.getSnapshot();
    assert.equal(snap.signedIn, false);
    assert.equal(snap.activeWorkspace, null);
    assert.deepEqual(snap.workspaces, []);
    assert.equal(snap.quota, null);
    assert.equal(snap.referral, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace switch, removed-member detection, and personal recovery lifecycle', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'om-collab-test-'));
  try {
    const mock = createMockAccountClient(dir, {
      velaSnapshot: {
        workspaceId: 'ws_team_1',
        billing: { billingState: 'active', planId: 'plus' },
        wallet: { balanceUsd: '88.50' },
        designPlanWindows: [
          { kind: '7d', remainingCredits: '75', limitCredits: '100', resetsAt: '2026-12-01T00:00:00Z' },
        ],
      },
    });
    const service = new WorkspaceCollabService(mock.client, { fetcher: mock.fetcher });
    const initial = await service.getSnapshot();
    assert.equal(initial.activeWorkspaceId, 'ws_personal');

    const switched = await service.switchWorkspace('ws_team_1');
    assert.equal(switched.activeWorkspaceId, 'ws_team_1');
    assert.equal(switched.quota?.weeklyPercentLeft, 75);
    assert.equal(switched.quota?.creditsUsd, '88.50');
    assert.equal(switched.referral?.resetCardsAvailable, 2);

    // Simulate user removal from ws_team_1.
    mock.setWorkspaces([
      {
        workspaceId: 'ws_personal',
        workspaceName: 'Personal',
        workspaceType: 'personal',
        workspaceMemberId: 'mem_p1',
        role: 'owner',
        isDefault: true,
        memberStatus: 'active',
        lifecycleState: 'active',
      },
      {
        workspaceId: 'ws_team_1',
        workspaceName: 'Studio Alpha',
        workspaceType: 'team',
        workspaceMemberId: 'mem_t1',
        role: 'member',
        isDefault: false,
        memberStatus: 'removed',
        lifecycleState: 'active',
      },
    ]);

    const removedSnap = await service.getSnapshot();
    assert.deepEqual(removedSnap.removedFromWorkspace, {
      workspaceId: 'ws_team_1',
      workspaceName: 'Studio Alpha',
    });

    const recovered = await service.recoverToPersonalWorkspace();
    assert.equal(recovered.activeWorkspaceId, 'ws_personal');
    assert.equal(recovered.removedFromWorkspace, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('multi-row invites enforce admin role restriction and report per-row partial failures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'om-collab-test-'));
  try {
    const idempotencySeen: string[] = [];
    const mock = createMockAccountClient(dir, {
      workspaces: [
        {
          workspaceId: 'ws_team_1',
          workspaceName: 'Studio Alpha',
          workspaceType: 'team',
          workspaceMemberId: 'mem_admin',
          role: 'admin',
          isDefault: false,
          memberStatus: 'active',
          lifecycleState: 'active',
        },
      ],
      fetcherResponses: [
        {
          urlMatch: /\/api\/v1\/workspaces\/ws_team_1\/invites$/,
          method: 'POST',
          handler: async (_url, init) => {
            const key = (init?.headers as Record<string, string>)['Idempotency-Key'];
            if (key) idempotencySeen.push(key);
            const body = JSON.parse(String(init?.body)) as { invitedEmail: string };
            if (body.invitedEmail === 'existing@team.io') {
              return new Response(JSON.stringify({ code: 'already_member' }), { status: 409 });
            }
            if (body.invitedEmail === 'fail@team.io') {
              return new Response(
                JSON.stringify({ inviteId: 'inv_2', deliveryStatus: 'delivery_failed' }),
                { status: 200 },
              );
            }
            return new Response(JSON.stringify({ inviteId: 'inv_1', deliveryStatus: 'sent' }), { status: 201 });
          },
        },
      ],
    });
    const service = new WorkspaceCollabService(mock.client, { fetcher: mock.fetcher });
    await service.switchWorkspace('ws_team_1');

    const batch = await service.inviteMembers('ws_team_1', [
      { email: 'bad-email', role: 'member' },
      { email: 'boss@team.io', role: 'admin' }, // admin cannot invite admin!
      { email: 'good@team.io', role: 'member', idempotencyKey: 'idem-1' },
      { email: 'existing@team.io', role: 'member', idempotencyKey: 'idem-2' },
      { email: 'fail@team.io', role: 'member', idempotencyKey: 'idem-3' },
    ]);

    assert.equal(batch.results[0].error, 'invalid_email');
    assert.equal(batch.results[1].error, 'forbidden');
    assert.equal(batch.results[2].ok, true);
    assert.equal(batch.results[2].inviteId, 'inv_1');
    assert.equal(batch.results[3].error, 'already_member');
    assert.equal(batch.results[4].error, 'delivery_failed');
    assert.deepEqual(idempotencySeen, ['idem-1', 'idem-2', 'idem-3']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('move project to team, visibility toggle, comment sync, and Cloud link routing persist properly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'om-collab-test-'));
  try {
    const mock = createMockAccountClient(dir);
    const service = new WorkspaceCollabService(mock.client, { fetcher: mock.fetcher });

    const moved = await service.moveProjectToWorkspace('proj_1', 'ws_team_1', true);
    assert.equal(moved.projectMeta.proj_1.workspaceId, 'ws_team_1');
    assert.equal(moved.projectMeta.proj_1.visibility, 'workspace');
    assert.equal(moved.preferences.skipMoveToTeamConfirm, true);

    const restricted = await service.setProjectVisibility('proj_1', 'private');
    assert.equal(restricted.projectMeta.proj_1.visibility, 'private');

    await service.reportCommentSyncState('proj_1', 'pending', 3);
    const afterSync = await service.retryCommentSync('proj_1');
    assert.equal(afterSync.commentSync.proj_1.state, 'synced');
    assert.equal(afterSync.commentSync.proj_1.pendingCount, 0);

    await service.switchWorkspace('ws_team_1');
    await service.openCloudDestination('members');
    assert.deepEqual(mock.openedUrls.at(-1), {
      targetPath: '/team?workspaceId=ws_team_1',
      entrySource: 'openmotion_manage_subscription',
      utmMedium: 'workspace_members',
    });
    await service.openCloudDestination('referral');
    assert.deepEqual(mock.openedUrls.at(-1), {
      targetPath: '/reset?entry_source=client_entry&expectedAppUserId=usr_1',
      entrySource: 'openmotion_manage_subscription',
      utmMedium: 'workspace_referral',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
