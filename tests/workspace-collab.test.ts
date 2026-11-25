import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountRequestError } from '../gateway/account.ts';
import { ModelGateway } from '../gateway/service.ts';
import {
  WorkspaceCollabService,
  type WorkspaceCollabAccountClient,
} from '../gateway/workspace-collab.ts';
import { collectUnifiedWorkspaceProjects } from '../gateway/workspace-projects.ts';
import type { AccountSummary } from '../shared/provider-directory.ts';
import {
  buildWorkspacePermissions,
  classifyBillingErrorCode,
  cloudDashboardTargetPath,
  isCloudIntentTargetPath,
  isFreeOrGoPlan,
  isMaxPlanTier,
  isValidInviteEmail,
} from '../shared/workspace-collab.ts';
import { WorkspaceStore } from '../workspace.ts';

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
      if (args[0] === 'team-projects') {
        return JSON.stringify({ ok: true });
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
    assert.equal(afterSync.commentSync.proj_1.state, 'failed');
    assert.equal(afterSync.commentSync.proj_1.pendingCount, 3);

    // Failed team-projects sync must reject without persisting local metadata.
    const origRun = mock.client.run;
    mock.client.run = async () => {
      throw new Error('vela offline');
    };
    await assert.rejects(() => service.moveProjectToWorkspace('proj_offline', 'ws_team_1', false), /Could not sync project/);
    assert.equal((await service.getSnapshot()).projectMeta.proj_offline, undefined);
    mock.client.run = origRun;

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

test('listWorkspaceMembers supports Cloud API, Vela CLI fallback, and offline self fallback', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'om-collab-members-'));
  try {
    // 1. Cloud API directory succeeds and sorts Owner -> Admin -> Member.
    const mockCloud = createMockAccountClient(dir, {
      fetcherResponses: [
        {
          urlMatch: /\/api\/v1\/workspaces\/ws_team_1\/members$/,
          method: 'GET',
          handler: () =>
            new Response(
              JSON.stringify({
                members: [
                  { memberId: 'mem_3', displayName: 'Noah Park', email: 'noah@acme.io', role: 'member', status: 'active' },
                  { memberId: 'mem_t1', displayName: 'Eli Huang', email: 'eli@example.com', role: 'owner', status: 'active' },
                  { memberId: 'mem_2', displayName: 'Maya Lin', email: 'maya@acme.io', role: 'admin', status: 'active' },
                  { memberId: 'mem_removed', displayName: 'Gone User', role: 'member', status: 'removed' },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        },
      ],
    });
    const serviceCloud = new WorkspaceCollabService(mockCloud.client, { fetcher: mockCloud.fetcher });
    const cloudMembers = await serviceCloud.listWorkspaceMembers('ws_team_1');
    assert.equal(cloudMembers.source, 'cloud_api');
    assert.deepEqual(cloudMembers.members.map(m => [m.name, m.role, Boolean(m.isCurrentUser)]), [
      ['Eli Huang', 'owner', true],
      ['Maya Lin', 'admin', false],
      ['Noah Park', 'member', false],
    ]);
    assert.equal(cloudMembers.canInviteMembers, true);
    assert.equal(cloudMembers.canInviteAdmins, true);

    // 2. Cloud API returns 404 -> falls back cleanly to Vela CLI collab member list.
    const baseMock = createMockAccountClient(dir, {
      fetcherResponses: [
        {
          urlMatch: /\/api\/v1\/workspaces\/ws_team_1\/members$/,
          method: 'GET',
          handler: () => new Response('Not found', { status: 404 }),
        },
      ],
    });
    const cliClient: WorkspaceCollabAccountClient = {
      ...baseMock.client,
      async run(args, signal, envOverrides) {
        if (args[0] === 'collab' && args[1] === 'member' && args[2] === 'list') {
          return JSON.stringify([{ memberId: 'mem_cli', name: 'CLI Collaborator', role: 'admin', status: 'active' }]);
        }
        return baseMock.client.run(args, signal, envOverrides);
      },
    };
    const serviceCli = new WorkspaceCollabService(cliClient, { fetcher: baseMock.fetcher });
    const cliMembers = await serviceCli.listWorkspaceMembers('ws_team_1');
    assert.equal(cliMembers.source, 'vela_cli');
    assert.equal(cliMembers.members[0].name, 'CLI Collaborator');

    // 3. Offline fallback returns self entry + seat count preserved.
    const serviceFallback = new WorkspaceCollabService(baseMock.client, { fetcher: baseMock.fetcher });
    const fallbackMembers = await serviceFallback.listWorkspaceMembers('ws_team_1');
    assert.equal(fallbackMembers.source, 'fallback');
    assert.equal(fallbackMembers.members.length, 1);
    assert.equal(fallbackMembers.members[0].isCurrentUser, true);
    assert.equal(fallbackMembers.totalCount, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bidirectional Share to team and Remove from team sync with Vela and enforce owner checks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'om-collab-remove-'));
  try {
    const cliCalls: string[][] = [];
    const base = createMockAccountClient(dir);
    const syncedClient: WorkspaceCollabAccountClient = {
      ...base.client,
      async run(args, signal, envOverrides) {
        cliCalls.push(args);
        if (args[0] === 'team-projects') return JSON.stringify({ ok: true });
        return base.client.run(args, signal, envOverrides);
      },
    };
    const service = new WorkspaceCollabService(syncedClient, { fetcher: base.fetcher });

    const moved = await service.moveProjectToWorkspace('proj_bi', 'ws_team_1', false, {
      kind: 'design',
      title: 'Brand Launch Deck',
    });
    assert.equal(moved.projectMeta.proj_bi.workspaceId, 'ws_team_1');
    assert.equal(moved.projectMeta.proj_bi.visibility, 'workspace');
    assert.equal(moved.projectMeta.proj_bi.kind, 'design');
    assert.equal(moved.projectMeta.proj_bi.ownerMemberId, 'mem_t1');
    assert.equal(moved.projectMeta.proj_bi.teamSynced, true);
    assert.ok(cliCalls.some(c => c[0] === 'team-projects' && c[1] === 'upsert' && c[2] === 'proj_bi'));

    const vis = await service.setProjectVisibility('proj_bi', 'private');
    assert.equal(vis.projectMeta.proj_bi.visibility, 'private');
    assert.ok(cliCalls.some(c => c[0] === 'team-projects' && c[1] === 'visibility' && c[3] === 'private'));

    const removed = await service.removeProjectFromTeam('proj_bi', true);
    assert.equal(removed.projectMeta.proj_bi.workspaceId, 'ws_personal');
    assert.equal(removed.projectMeta.proj_bi.visibility, 'private');
    assert.equal(removed.projectMeta.proj_bi.teamSynced, false);
    assert.ok(typeof removed.projectMeta.proj_bi.removedFromTeamAt === 'number');
    assert.equal(removed.preferences.skipRemoveFromTeamConfirm, true);
    assert.ok(cliCalls.some(c => c[0] === 'team-projects' && c[1] === 'remove' && c[2] === 'proj_bi'));

    // Removing a Personal project throws cleanly.
    await assert.rejects(() => service.removeProjectFromTeam('proj_bi'), /not shared in a team workspace/i);

    // Non-owner cannot remove another member's shared project.
    await service.moveProjectToWorkspace('proj_other', 'ws_team_1');
    const memberClient: WorkspaceCollabAccountClient = {
      ...syncedClient,
      async listAllWorkspaceRecords() {
        return [
          {
            workspaceId: 'ws_team_1',
            workspaceName: 'Studio Alpha',
            workspaceType: 'team',
            workspaceMemberId: 'mem_other',
            role: 'member',
            isDefault: false,
            memberStatus: 'active',
            lifecycleState: 'active',
          },
        ];
      },
    };
    const serviceAsOther = new WorkspaceCollabService(memberClient, { fetcher: base.fetcher });
    await assert.rejects(() => serviceAsOther.removeProjectFromTeam('proj_other'), /creator/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectUnifiedWorkspaceProjects combines Motion, Design, and user Game projects with share status', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'om-collab-projects-'));
  try {
    const mock = createMockAccountClient(dir);
    const service = new WorkspaceCollabService(mock.client, { fetcher: mock.fetcher });
    await service.switchWorkspace('ws_team_1');
    await service.moveProjectToWorkspace('design_1', 'ws_team_1', false, { kind: 'design', title: 'Landing Page' });
    await service.moveProjectToWorkspace('motion_priv', 'ws_team_1', false, { kind: 'motion', title: 'Secret Teaser' });
    await service.setProjectVisibility('motion_priv', 'private');

    const unified = await collectUnifiedWorkspaceProjects(
      {
        directory: dir,
        motionCatalog: () => ({
          projects: [
            { id: 'motion_1', title: 'Launch Film', openedAt: 100 },
            { id: 'motion_priv', title: 'Secret Teaser', openedAt: 300 },
            { id: 'motion_trash', title: 'Old Draft', trashedAt: 50 },
          ],
        }),
        designList: async ({ trashed }) =>
          trashed
            ? []
            : [
                {
                  id: 'design_1',
                  title: 'Landing Page',
                  scenario: 'landing',
                  entry: 'index.html',
                  designSystemId: null,
                  templateId: null,
                  source: 'blank',
                  createdAt: 100,
                  updatedAt: 500,
                  trashedAt: null,
                  revision: 'r1',
                  versionId: null,
                  versionLabel: 'v1',
                },
              ],
        gameCatalog: async () => ({
          games: [
            {
              id: 'tpl_game',
              title: 'Built-in Template Game',
              description: '',
              genre: 'casual',
              style: 'minimal',
              setting: 'retro',
              multiplayer: false,
              maxPlayers: 1,
              status: 'published',
              cover: null,
              playUrl: '/api/games/tpl_game/play/index.html',
              plays: 0,
              likes: 0,
              dislikes: 0,
              reaction: 0,
              favorite: false,
              source: 'template',
              remixOf: null,
              controls: '',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
            {
              id: 'game_mine',
              title: 'Neon Runner',
              description: 'My game',
              genre: 'platformer',
              style: 'pixel',
              setting: 'cyberpunk',
              multiplayer: false,
              maxPlayers: 1,
              status: 'ready',
              cover: '/api/games/game_mine/cover.png',
              playUrl: '/api/games/game_mine/play/index.html',
              plays: 3,
              likes: 1,
              dislikes: 0,
              reaction: 0,
              favorite: true,
              source: 'mine',
              remixOf: null,
              controls: '',
              createdAt: '2026-10-01T00:00:00Z',
              updatedAt: '2026-10-02T00:00:00Z',
            },
          ],
        }),
        webPublishList: async () => ({
          accountSignedIn: true,
          publications: [
            {
              schemaVersion: 1,
              targetKind: 'design',
              targetId: 'design_1',
              cloudProjectId: 'design_1',
              projectId: 'design_1',
              filePath: 'index.html',
              entryPath: 'index.html',
              name: 'Landing Page',
              workspaceId: 'ws_team_1',
              ownerMemberId: 'mem_t1',
              resourceId: 'res_1',
              sourceFileId: 'sf_1',
              sourceKey: 'sk_1',
              slug: 'landing-page',
              version: 2,
              versionId: 'v2',
              status: 'published',
              url: 'https://open-design.app/artifact/landing-page',
              publishedAt: 500,
              updatedAt: 500,
              fileCount: 2,
              totalBytes: 1024,
              sourceRevision: 'r1',
            },
          ],
        }),
      },
      service,
      { includeRemoteSync: false },
    );

    assert.equal(unified.counts.total, 4);
    assert.equal(unified.counts.personal, 2);
    assert.equal(unified.counts.teamShared, 1);
    assert.equal(unified.counts.teamPrivate, 1);
    assert.equal(unified.counts.motion, 2);
    assert.equal(unified.counts.design, 1);
    assert.equal(unified.counts.game, 1);
    assert.equal(unified.counts.trashed, 1);
    assert.equal(unified.projects.some(p => p.id === 'tpl_game'), false);

    const designCard = unified.projects.find(p => p.id === 'design_1')!;
    assert.equal(designCard.shareStatus, 'team_shared');
    assert.equal(designCard.webPublish.status, 'published');
    assert.equal(designCard.permissions.canRemoveFromTeam, true);

    const privCard = unified.projects.find(p => p.id === 'motion_priv')!;
    assert.equal(privCard.shareStatus, 'team_private');
    assert.equal(privCard.permissions.canChangeVisibility, true);

    const personalCard = unified.projects.find(p => p.id === 'motion_1')!;
    assert.equal(personalCard.shareStatus, 'personal');
    assert.equal(personalCard.permissions.canShareToTeam, true);
    assert.equal(personalCard.permissions.canRemoveFromTeam, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Phase A helpers classify billing error codes, Free/Go vs Max plans', () => {
  assert.equal(isFreeOrGoPlan('free'), true);
  assert.equal(isFreeOrGoPlan('go'), true);
  assert.equal(isFreeOrGoPlan('team_go'), true);
  assert.equal(isFreeOrGoPlan('plus'), false);
  assert.equal(isFreeOrGoPlan('max'), false);

  assert.equal(isMaxPlanTier('max'), true);
  assert.equal(isMaxPlanTier('team_max'), true);
  assert.equal(isMaxPlanTier('pro'), false);

  assert.equal(classifyBillingErrorCode('insufficient_balance'), 'insufficient_balance');
  assert.equal(
    classifyBillingErrorCode('Your OpenDesign balance is too low for this request. Top up, then try again.'),
    'insufficient_balance',
  );
  assert.equal(classifyBillingErrorCode('tier_limit_exceeded'), 'tier_limit_exceeded');
  assert.equal(
    classifyBillingErrorCode('OpenDesign media rate or concurrency limit reached. Wait for running tasks to finish, then try again.'),
    'tier_limit_exceeded',
  );
  assert.equal(classifyBillingErrorCode('tier_model_not_entitled'), 'plan_not_entitled');
  assert.equal(classifyBillingErrorCode('model_access_denied'), 'plan_not_entitled');
  assert.equal(classifyBillingErrorCode('Server restarted unexpectedly'), null);
});

test('preflightWorkspace and getRequestConcurrency handle Vela JSON, billing-summary fallback, locked workspace, and unavailable errors', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'om-collab-preflight-'));
  try {
    // 1. Vela billing preflight + request-concurrency JSON
    let currentWorkspaces = [
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
      },
    ];
    let preflightPayload: Record<string, unknown> | Error = {
      funded: false,
      reason: 'insufficient_balance',
      planId: 'free',
      balanceUsd: '0.00',
      weeklyPercentLeft: 0,
    };
    let concurrencyPayload: Record<string, unknown> | Error = {
      inFlight: 2,
      limit: 2,
    };

    const customClient: WorkspaceCollabAccountClient = {
      root: dir,
      async summary(): Promise<AccountSummary> {
        return {
          state: 'signed-in',
          user: { name: 'Eli', email: 'eli@example.com' },
          plan: 'plus',
          balance: '0.00',
          consoleUrl: 'https://open-design.ai/cloud',
        };
      },
      async getControlSession() {
        return {
          apiUrl: 'https://amr-api.open-design.ai',
          controlKey: 'ctrl_secret',
          user: { id: 'usr_1', name: 'Eli', email: 'eli@example.com' },
        };
      },
      async listAllWorkspaceRecords() {
        return currentWorkspaces;
      },
      async run(args) {
        if (args[0] === 'billing' && args[1] === 'preflight') {
          if (preflightPayload instanceof Error) throw preflightPayload;
          return JSON.stringify(preflightPayload);
        }
        if (args[0] === 'billing' && args[1] === 'request-concurrency') {
          if (concurrencyPayload instanceof Error) throw concurrencyPayload;
          return JSON.stringify(concurrencyPayload);
        }
        if (args[0] === 'billing' && args[1] === 'workspace-snapshot') {
          return JSON.stringify({
            workspaceId: currentWorkspaces[1].workspaceId,
            billing: { planId: 'free', billingState: 'free' },
            wallet: { balanceUsd: '0.00' },
            designPlanWindows: [{ kind: '7d', limitCredits: 100, remainingCredits: 0, resetsAt: '2026-12-01T00:00:00Z' }],
          });
        }
        throw new Error('unsupported');
      },
      async openCloudUrl(targetPath) {
        return { url: `https://open-design.ai/cloud${targetPath}`, opened: true };
      },
    };

    const mock = createMockAccountClient(dir);
    const service = new WorkspaceCollabService(customClient, { fetcher: mock.fetcher });
    await service.switchWorkspace('ws_team_1');

    const pre1 = await service.preflightWorkspace({ model: 'seedream-5.5' });
    assert.equal(pre1.funded, false);
    assert.equal(pre1.reason, 'insufficient_balance');
    assert.equal(pre1.balanceUsd, '0.00');
    assert.equal(pre1.audience, 'owner');
    assert.equal(pre1.source, 'vela-preflight');

    const conc1 = await service.getRequestConcurrency();
    assert.equal(conc1.available, true);
    assert.equal(conc1.inFlight, 2);
    assert.equal(conc1.limit, 2);
    assert.equal(conc1.isMaxPlan, false);
    assert.equal(conc1.audience, 'owner');

    // 2. Fallback to billing-summary snapshot + member audience when preflight CLI throws
    preflightPayload = new Error('preflight cli unsupported');
    concurrencyPayload = new Error('concurrency cli unsupported');
    currentWorkspaces[1] = { ...currentWorkspaces[1], role: 'member' };
    const pre2 = await service.preflightWorkspace();
    assert.equal(pre2.funded, false);
    assert.equal(pre2.reason, 'insufficient_balance');
    assert.equal(pre2.audience, 'member');
    assert.equal(pre2.source, 'billing-summary');

    const conc2 = await service.getRequestConcurrency();
    assert.equal(conc2.available, false);
    assert.equal(conc2.inFlight, null);
    assert.equal(conc2.limit, null);
    assert.equal(conc2.audience, 'member');

    // 3. Locked workspace short-circuits immediately
    currentWorkspaces[1] = { ...currentWorkspaces[1], lifecycleState: 'locked' };
    const pre3 = await service.preflightWorkspace();
    assert.equal(pre3.funded, false);
    assert.equal(pre3.reason, 'workspace_locked');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ModelGateway persists structured GenerationJob.errorCode on AccountRequestError and HTTP 402/429 failures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'om-gateway-errorcode-'));
  const previousAccountDir = process.env.MOTION_ACCOUNT_DIR;
  process.env.MOTION_ACCOUNT_DIR = path.join(dir, 'account');
  try {
    await mkdir(path.join(dir, 'project'), { recursive: true });
    await writeFile(path.join(dir, 'project', 'index.html'), '<!doctype html><html><body></body></html>');
    const store = new WorkspaceStore(dir);
    let nextStatus = 402;
    const gateway = new ModelGateway(store, {
      detect: async () => [],
      pollMs: 1,
      fetcher: (async () =>
        new Response(JSON.stringify({ error: 'quota' }), {
          status: nextStatus,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch,
    });
    try {
      await gateway.configureProvider('fal', { apiKey: 'test-only' });

      const job402 = await gateway.submit({ modality: 'image', prompt: 'sunset', model: 'fal:fal-ai/flux/schnell' });
      await gateway.tick();
      await Promise.all([...gateway.active.values()].map(t => t.done));
      const res402 = await gateway.getJob(job402.id);
      assert.equal(res402.state, 'failed');
      assert.equal(res402.errorCode, 'insufficient_balance');

      nextStatus = 429;
      const job429 = await gateway.submit({ modality: 'image', prompt: 'city', model: 'fal:fal-ai/flux/schnell' });
      await gateway.tick();
      await Promise.all([...gateway.active.values()].map(t => t.done));
      const res429 = await gateway.getJob(job429.id);
      assert.equal(res429.state, 'failed');
      assert.equal(res429.errorCode, 'tier_limit_exceeded');

      // AccountRequestError code propagation
      (gateway.account as unknown as {
        generate: () => Promise<Buffer[]>;
        mediaCredential?: () => Promise<string>;
      }).generate = async () => {
        throw new AccountRequestError('Media rejected (insufficient_balance, HTTP 402)');
      };
      await mkdir(path.join(dir, 'account', 'credentials'), { recursive: true });
      await writeFile(path.join(dir, 'account', 'session.json'), JSON.stringify({ id: 'sess_1' }));
      await writeFile(
        path.join(dir, 'account', 'credentials', 'config.json'),
        JSON.stringify({
          profiles: {
            prod: {
              apiUrl: 'https://amr-api.open-design.ai',
              controlKey: 'ctrl_1',
              controlKeyId: 'ck_1',
              runtimeKey: 'rt_1',
              user: { id: 'usr_1', name: 'Eli', email: 'eli@example.com' },
            },
          },
        }),
      );
      await writeFile(
        path.join(dir, 'account', 'models.json'),
        JSON.stringify([
          {
            id: 'account:test-img',
            provider: 'account',
            modelId: 'test-img',
            label: 'Test Image',
            kind: 'image',
            enabled: true,
            source: 'live',
            mode: 'text-to-image',
          },
        ]),
      );
      const jobAcc = await gateway.submit({ modality: 'image', prompt: 'moon', model: 'account:test-img' });
      await gateway.tick();
      await Promise.all([...gateway.active.values()].map(t => t.done));
      const resAcc = await gateway.getJob(jobAcc.id);
      assert.equal(resAcc.state, 'failed');
      assert.equal(resAcc.errorCode, 'insufficient_balance');
    } finally {
      await gateway.close();
    }
  } finally {
    if (previousAccountDir === undefined) delete process.env.MOTION_ACCOUNT_DIR;
    else process.env.MOTION_ACCOUNT_DIR = previousAccountDir;
    await rm(dir, { recursive: true, force: true });
  }
});
