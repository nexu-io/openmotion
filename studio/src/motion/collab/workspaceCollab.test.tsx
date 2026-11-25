// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCollabSnapshot, WorkspaceDirectoryEntry } from '../../../../shared/workspace-collab';
import { buildWorkspacePermissions } from '../../../../shared/workspace-collab';
import { WebPublishPopover } from '../../components/WebPublishPopover';
import { I18nProvider } from '../../i18n/I18n';
import { WorkspaceCollabProvider, useWorkspaceCollab } from '../WorkspaceCollabContext';
import { ApplicationAccountMenu } from '../ApplicationChrome';
import { peekCachedRepositoryStars } from '../githubRepository';
import { ProjectsPage } from '../ProjectsPage';
import { CommentSyncBanner } from './CommentSyncBanner';
import { HeaderInviteTrigger, InviteMembersDialog } from './InviteMembersDialog';
import { MoveToTeamDialog } from './MoveToTeamDialog';
import { ProjectSharingDialog } from './ProjectSharingDialog';
import { ProjectScopeTabs, filterProjectsByScope } from './ProjectScopeTabs';
import { ReferralEntryCard } from './ReferralEntryCard';
import { RemoveFromTeamDialog } from './RemoveFromTeamDialog';
import { TeamMembersDialog } from './TeamMembersDialog';
import { BillingGateDialog, UpgradeCard } from './UpgradeCard';
import { resetArtifactUpgradeCooldown, emitArtifactDelivered } from './artifactDeliveryBus';
import { WorkspaceQuotaPopover } from './WorkspaceQuotaPopover';
import { WorkspaceRemovalBoundary } from './WorkspaceRemovalBoundary';
import { WorkspaceScopeNotice } from './WorkspaceScopeNotice';
import { WorkspaceSettingsSection } from './WorkspaceSettingsSection';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { WorkspaceCollabBanner, resolvePriorityBanner } from './WorkspaceTopBanner';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(ticks = 6) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function makeWorkspace(overrides: Partial<WorkspaceDirectoryEntry> = {}): WorkspaceDirectoryEntry {
  return {
    workspaceId: 'ws_team_1',
    workspaceName: 'Studio Team',
    workspaceType: 'team',
    workspaceMemberId: 'mem_1',
    role: 'owner',
    isDefault: false,
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: 'plus',
    memberCount: 4,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<WorkspaceCollabSnapshot> = {}): WorkspaceCollabSnapshot {
  const personal = makeWorkspace({
    workspaceId: 'ws_personal',
    workspaceName: 'Personal Studio',
    workspaceType: 'personal',
    isDefault: true,
    planId: 'free',
    billingState: 'free',
  });
  const team = overrides.activeWorkspace ?? makeWorkspace();
  const active = overrides.activeWorkspace === undefined ? team : overrides.activeWorkspace;
  return {
    signedIn: true,
    accountState: 'signed-in',
    user: { name: 'Eli', email: 'eli@example.com' },
    workspaces: [personal, ...(active?.workspaceType === 'team' ? [active] : [makeWorkspace()])],
    activeWorkspaceId: active?.workspaceId ?? null,
    activeWorkspace: active,
    permissions: active ? buildWorkspacePermissions(active) : buildWorkspacePermissions({}),
    removedFromWorkspace: null,
    quota: active
      ? {
          workspaceId: active.workspaceId,
          planId: active.planId || 'plus',
          planLabel: active.planId === 'free' ? 'Free' : 'Plus',
          billingState: active.billingState,
          lifecycleState: active.lifecycleState,
          weeklyPercentLeft: 82,
          weeklyResetsAt: '2026-12-01T00:00:00Z',
          weeklyLimitExhausted: false,
          creditsUsd: '125.85',
          creditsExhausted: false,
          hasAvailableFunds: true,
        }
      : null,
    referral: {
      available: true,
      referralUrl: 'https://open-design.ai/cloud/referral?code=ELIX5',
      referralCode: 'ELIX5',
      resetCardsAvailable: 2,
      invitedCount: 2,
      inviteTarget: 5,
      inviteeWindowActive: false,
      inviteeWindowEndsAt: null,
    },
    projectMeta: {},
    commentSync: {},
    preferences: { skipMoveToTeamConfirm: false, dismissedBanners: [] },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe('OpenDesign client collaboration components', () => {
  it('opens workspace switcher and confirms switch during an active task', async () => {
    let snapshot = makeSnapshot();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/motion-api/workspace/collab')) return jsonResponse(snapshot);
      if (url.endsWith('/motion-api/workspace/collab/switch')) {
        const { workspaceId } = JSON.parse(String(init?.body)) as { workspaceId: string };
        const nextWs = snapshot.workspaces.find(w => w.workspaceId === workspaceId)!;
        snapshot = makeSnapshot({ activeWorkspace: nextWs, activeWorkspaceId: nextWs.workspaceId });
        return jsonResponse(snapshot);
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider hasActiveTask>
            <WorkspaceSwitcher />
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="workspace-switcher-trigger"]')!;
    expect(trigger.textContent).toContain('Studio Team');

    await act(async () => {
      trigger.click();
    });
    await flush();

    const options = [...document.body.querySelectorAll<HTMLButtonElement>('.om-ws-popover-option')];
    const personalBtn = options.find(el => el.textContent?.includes('Personal Studio'))!;
    await act(async () => {
      personalBtn.click();
    });
    await flush();

    // Active task prompt renders before calling switch endpoint.
    expect(document.body.textContent).toContain('Switch workspace?');
    const confirmBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.om-collab-dialog-footer button')].find(
      b => b.textContent?.includes('Switch workspace'),
    )!;
    await act(async () => {
      confirmBtn.click();
    });
    await flush();

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/motion-api/workspace/collab/switch'))).toBe(true);
    expect(container.querySelector('[data-testid="workspace-switcher-trigger"]')!.textContent).toContain('Personal Studio');
  });

  it('handles multi-row invite partial failure, inline retry, and hides Admin option for Admins', async () => {
    const adminTeam = makeWorkspace({ role: 'admin' });
    const snapshot = makeSnapshot({ activeWorkspace: adminTeam });
    let inviteCalls = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/motion-api/workspace/collab')) return jsonResponse(snapshot);
        if (url.endsWith('/motion-api/workspace/collab/invites')) {
          inviteCalls++;
          const { rows } = JSON.parse(String(init?.body)) as { rows: { email: string; role: 'member' | 'admin' }[] };
          return jsonResponse({
            workspaceId: 'ws_team_1',
            results: rows.map(r =>
              r.email === 'flaky@team.io' && inviteCalls === 1
                ? { email: r.email, role: r.role, ok: false, error: 'delivery_failed', message: 'Email delivery failed.' }
                : { email: r.email, role: r.role, ok: true, inviteId: 'inv_ok' },
            ),
          });
        }
        return jsonResponse({});
      }),
    );

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <HeaderInviteTrigger />
            <InviteMembersDialog />
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="header-invite-trigger"]')!;
    await act(async () => {
      trigger.click();
    });
    await flush();

    // Admin sees Member only (role selector disabled / no admin choice).
    const addBtn = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(b =>
      b.textContent?.includes('Add another'),
    )!;
    await act(async () => {
      addBtn.click();
    });
    await flush();

    const inputs = [...document.body.querySelectorAll<HTMLInputElement>('.om-invite-row input[type="email"]')];
    expect(inputs.length).toBe(2);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(inputs[0], 'ok@team.io');
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(inputs[1], 'flaky@team.io');
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const sendBtn = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(b =>
      b.textContent?.includes('Send invitations'),
    )!;
    await act(async () => {
      sendBtn.click();
    });
    await flush();

    expect(document.body.textContent).toContain('Invitation sent');
    expect(document.body.textContent).toContain('Email delivery failed.');

    const retryBtn = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(b =>
      b.textContent?.includes('Retry failed'),
    )!;
    await act(async () => {
      retryBtn.click();
    });
    await flush();

    expect(inviteCalls).toBe(2);
    expect(document.body.querySelectorAll('[data-ok="false"]').length).toBe(0);
  });

  it('shows Owner billing links vs Member owner-only notice in QuotaPopover and UpgradeCard', async () => {
    let snapshot = makeSnapshot();
    snapshot.quota!.hasAvailableFunds = false;
    snapshot.quota!.weeklyPercentLeft = 0;
    snapshot.quota!.weeklyLimitExhausted = true;
    snapshot.quota!.creditsUsd = '0.00';
    snapshot.quota!.creditsExhausted = true;

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(snapshot)));

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <WorkspaceQuotaPopover />
            <UpgradeCard />
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="workspace-quota-trigger"]')!.click();
    });
    await flush();
    expect(document.body.querySelector('[data-testid="quota-owner-actions"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="super-agent-upgrade-card"]')!.textContent).toContain('Upgrade or top up');

    // Simulate account/role update via motion:account-changed event as non-owner Member.
    const memberWs = makeWorkspace({ role: 'member' });
    snapshot = {
      ...snapshot,
      activeWorkspace: memberWs,
      permissions: buildWorkspacePermissions(memberWs),
    };
    await act(async () => {
      window.dispatchEvent(new Event('motion:account-changed'));
    });
    await flush();

    // Popover is already open from previous step or reopen cleanly if needed.
    if (!document.body.querySelector('[data-testid="quota-member-notice"]')) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="workspace-quota-trigger"]')!.click();
      });
      await flush();
    }
    expect(document.body.querySelector('[data-testid="quota-owner-actions"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="quota-member-notice"]')).not.toBeNull();
    const card = container.querySelector('[data-testid="super-agent-upgrade-card"]')!;
    expect(card.textContent).not.toContain('Upgrade or top up');
    expect(card.textContent).toContain('Switch to personal');
  });

  it('enforces exclusive banner priority stack and removal boundary 1-click recovery', async () => {
    expect(
      resolvePriorityBanner({
        signedIn: true,
        isExploreHome: true,
        bfBannerVisible: true,
        lifecycleState: 'locked',
        weeklyLimitExhausted: true,
        inviteeWindowActive: true,
        canInviteMembers: true,
        workspaceType: 'team',
        workspaceId: 'ws_1',
      })?.kind,
    ).toBe('locked');

    expect(
      resolvePriorityBanner({
        signedIn: true,
        isExploreHome: true,
        bfBannerVisible: true,
        lifecycleState: 'active',
        weeklyLimitExhausted: true,
        canInviteMembers: true,
        workspaceType: 'team',
        workspaceId: 'ws_1',
      })?.kind,
    ).toBe('referral');

    let snapshot = makeSnapshot({
      removedFromWorkspace: { workspaceId: 'ws_team_1', workspaceName: 'Studio Team' },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/motion-api/workspace/collab')) return jsonResponse(snapshot);
      if (String(input).endsWith('/motion-api/workspace/collab/recover-personal')) {
        snapshot = makeSnapshot({ removedFromWorkspace: null, activeWorkspace: makeWorkspace({ workspaceType: 'personal', workspaceId: 'ws_personal' }) });
        return jsonResponse(snapshot);
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <WorkspaceCollabBanner banner={{ kind: 'referral', key: 'referral:ws_team_1' }} />
            <WorkspaceRemovalBoundary />
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();

    const boundary = container.querySelector('[data-testid="workspace-removal-boundary"]')!;
    expect(boundary.textContent).toContain('Studio Team');
    await act(async () => {
      boundary.querySelector('button')!.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="workspace-removal-boundary"]')).toBeNull();
  });

  it('moves project to team with skip-confirm, retries comment sync, filters scope tabs, and renders settings & scope surfaces', async () => {
    let snapshot = makeSnapshot({
      commentSync: {
        proj_1: {
          projectId: 'proj_1',
          state: 'failed',
          pendingCount: 2,
          lastError: 'Sync paused while offline',
          updatedAt: Date.now(),
        },
      },
      quota: {
        workspaceId: 'ws_team_1',
        planId: 'plus',
        planLabel: 'Plus',
        billingState: 'locked',
        lifecycleState: 'locked',
        weeklyPercentLeft: 0,
        weeklyResetsAt: null,
        weeklyLimitExhausted: true,
        creditsUsd: '0.00',
        creditsExhausted: true,
        hasAvailableFunds: false,
      },
      activeWorkspace: makeWorkspace({ lifecycleState: 'locked' }),
      permissions: buildWorkspacePermissions(makeWorkspace({ lifecycleState: 'locked', role: 'owner' })),
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/motion-api/workspace/collab')) return jsonResponse(snapshot);
      if (url.endsWith('/motion-api/workspace/collab/projects/proj_1/move')) {
        snapshot = makeSnapshot({
          projectMeta: { proj_1: { projectId: 'proj_1', workspaceId: 'ws_team_1', visibility: 'workspace' } },
          preferences: { skipMoveToTeamConfirm: true, dismissedBanners: [] },
        });
        return jsonResponse(snapshot);
      }
      if (url.endsWith('/motion-api/workspace/collab/comments/proj_1/sync')) {
        snapshot = makeSnapshot({
          commentSync: { proj_1: { projectId: 'proj_1', state: 'synced', pendingCount: 0, updatedAt: Date.now() } },
        });
        return jsonResponse(snapshot);
      }
      if (url.endsWith('/motion-api/settings/account')) {
        return jsonResponse({ state: 'signed-in', user: { email: 'eli@example.com' }, consoleUrl: 'https://open-design.ai/cloud' });
      }
      if (url.includes('/motion-api/web-publish/motion/proj_1')) {
        return jsonResponse({
          targetKind: 'motion',
          targetId: 'proj_1',
          projectId: 'proj_1',
          accountSignedIn: true,
          accountState: 'signed-in',
          publications: [],
          deployments: [],
          active: null,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    function Harness() {
      const collab = useWorkspaceCollab();
      return (
        <div>
          <WorkspaceScopeNotice surface="assets" />
          <ProjectScopeTabs value="team" onChange={() => {}} />
          <CommentSyncBanner projectId="proj_1" />
          <WorkspaceSettingsSection />
          <ReferralEntryCard />
          <WebPublishPopover targetKind="motion" targetId="proj_1" />
          <MoveToTeamDialog />
          <BillingGateDialog />
          <button
            data-testid="open-move"
            type="button"
            onClick={() => collab.requestMoveToTeam({ id: 'proj_1', title: 'Launch Cut' })}
          >
            open
          </button>
        </div>
      );
    }

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <Harness />
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();

    // Verify scope tabs helper.
    const scoped = filterProjectsByScope(
      [{ id: 'p1' }, { id: 't1' }, { id: 't2' }],
      'team',
      { t1: { workspaceId: 'ws_team_1' }, t2: { workspaceId: 'ws_team_2' } },
      new Set(['ws_personal']),
      new Set(['ws_team_1', 'ws_team_2']),
    );
    expect(scoped.map(p => p.id)).toEqual(['t1', 't2']);

    const specificTeamScoped = filterProjectsByScope(
      [{ id: 'p1' }, { id: 't1' }, { id: 't2' }],
      'team:ws_team_2',
      { t1: { workspaceId: 'ws_team_1' }, t2: { workspaceId: 'ws_team_2' } },
      new Set(['ws_personal']),
      new Set(['ws_team_1', 'ws_team_2']),
    );
    expect(specificTeamScoped.map(p => p.id)).toEqual(['t2']);

    // Verify Settings locked billing recovery + Referral card + ScopeNotice.
    expect(container.querySelector('[data-testid="scope-notice-assets"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-workspace-section"]')!.textContent).toContain('Restore billing');
    expect(container.querySelector('[data-testid="referral-entry-card"]')!.textContent).toContain('2 reset cards ready');

    // Retry comment sync banner.
    const syncBtn = container.querySelector('[data-testid="comment-sync-banner"] button')! as HTMLButtonElement;
    await act(async () => {
      syncBtn.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="comment-sync-banner"]')).toBeNull();
    expect(container.querySelector('[data-testid="comment-team-presence"]')).not.toBeNull();

    // Open WebPublishPopover to confirm dual-flow team visibility block mounts.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.om-web-publish-trigger')!.click();
    });
    await flush();
    expect(document.body.querySelector('[data-testid="share-workspace-collab"]')).not.toBeNull();

    // Open MoveToTeamDialog and submit with Don't ask again.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-move"]')!.click();
    });
    await flush();
    const checkbox = document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
    await act(async () => {
      checkbox.click();
    });
    const moveConfirm = [...document.body.querySelectorAll<HTMLButtonElement>('.om-collab-dialog-footer button')].find(
      b => b.textContent?.includes('Move to team'),
    )!;
    await act(async () => {
      moveConfirm.click();
    });
    await flush();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/move'))).toBe(true);
  });

  it('unifies Motion/Design/Game in ProjectsPage with Share to team, Collaborators, Visibility, and Remove from team', async () => {
    let snapshot = makeSnapshot({
      projectMeta: {
        design_shared: {
          projectId: 'design_shared',
          workspaceId: 'ws_team_1',
          visibility: 'workspace',
          kind: 'design',
          ownerMemberId: 'mem_1',
          ownerName: 'Eli',
        },
        game_priv: {
          projectId: 'game_priv',
          workspaceId: 'ws_team_1',
          visibility: 'private',
          kind: 'game',
          ownerMemberId: 'mem_1',
          ownerName: 'Eli',
        },
      },
    });

    const buildCatalog = () => {
      const mMeta = snapshot.projectMeta.motion_1;
      const dMeta = snapshot.projectMeta.design_shared;
      const gMeta = snapshot.projectMeta.game_priv;
      const makeEntry = (
        id: string,
        kind: 'motion' | 'design' | 'game',
        title: string,
        meta: typeof mMeta,
        extra: Record<string, unknown> = {},
      ) => {
        const inTeam = meta?.workspaceId === 'ws_team_1';
        const visibility = meta?.visibility ?? (inTeam ? 'workspace' : 'private');
        const shareStatus = !inTeam ? 'personal' : visibility === 'workspace' ? 'team_shared' : 'team_private';
        return {
          id,
          kind,
          title,
          updatedAt: Date.now(),
          shareStatus,
          workspaceId: inTeam ? 'ws_team_1' : 'ws_personal',
          workspaceName: inTeam ? 'Studio Team' : 'Personal Studio',
          visibility,
          ownerMemberId: 'mem_1',
          ownerName: 'Eli',
          isOwner: true,
          webPublish: extra.webPublish ?? { status: 'none' },
          permissions: {
            canOpen: true,
            canShareToTeam: shareStatus === 'personal',
            canChangeVisibility: shareStatus !== 'personal',
            canRemoveFromTeam: shareStatus !== 'personal',
            canRename: true,
            canDelete: true,
          },
        };
      };

      const projects = [
        makeEntry('motion_1', 'motion', 'Launch Film', mMeta),
        makeEntry('design_shared', 'design', 'Cloud Spec Sheet', dMeta, {
          webPublish: { status: 'published', url: 'https://open-design.app/artifact/spec' },
        }),
        makeEntry('game_priv', 'game', 'Neon Arcade', gMeta),
      ];
      return {
        activeWorkspaceId: snapshot.activeWorkspaceId,
        activeWorkspaceName: snapshot.activeWorkspace?.workspaceName ?? null,
        activeWorkspaceType: snapshot.activeWorkspace?.workspaceType ?? null,
        projects,
        trashed: [],
        counts: {
          total: projects.length,
          personal: projects.filter(p => p.shareStatus === 'personal').length,
          teamShared: projects.filter(p => p.shareStatus === 'team_shared').length,
          teamPrivate: projects.filter(p => p.shareStatus === 'team_private').length,
          motion: 1,
          design: 1,
          game: 1,
          trashed: 0,
        },
      };
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/motion-api/workspace/collab')) return jsonResponse(snapshot);
      if (url.endsWith('/motion-api/workspace/projects')) return jsonResponse(buildCatalog());
      if (url.includes('/motion-api/workspace/collab/members')) {
        return jsonResponse({
          workspaceId: 'ws_team_1',
          workspaceName: 'Studio Team',
          workspaceType: 'team',
          source: 'cloud_api',
          totalCount: 2,
          canInviteMembers: true,
          canInviteAdmins: true,
          canManageMembersInCloud: true,
          members: [
            { memberId: 'mem_1', name: 'Eli', email: 'eli@example.com', role: 'owner', status: 'active', isCurrentUser: true },
            { memberId: 'mem_2', name: 'Maya', email: 'maya@example.com', role: 'member', status: 'active' },
          ],
        });
      }
      if (url.includes('/motion-api/web-publish/motion/motion_1')) {
        return jsonResponse({
          targetKind: 'motion',
          targetId: 'motion_1',
          projectId: 'motion_1',
          accountSignedIn: true,
          publications: [],
          deployments: [],
          active: null,
        });
      }
      if (url.endsWith('/motion-api/workspace/collab/projects/motion_1/move')) {
        const { workspaceId, kind } = JSON.parse(String(init?.body)) as { workspaceId: string; kind?: 'motion' | 'design' | 'game' };
        snapshot = makeSnapshot({
          projectMeta: {
            ...snapshot.projectMeta,
            motion_1: { projectId: 'motion_1', workspaceId, visibility: 'workspace', kind: kind ?? 'motion', ownerMemberId: 'mem_1' },
          },
        });
        return jsonResponse(snapshot);
      }
      if (url.endsWith('/motion-api/workspace/collab/projects/motion_1/remove-from-team')) {
        snapshot = makeSnapshot({
          projectMeta: {
            ...snapshot.projectMeta,
            motion_1: { projectId: 'motion_1', workspaceId: 'ws_personal', visibility: 'private', kind: 'motion' },
          },
        });
        return jsonResponse(snapshot);
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <ProjectsPage
              onOpenMotionProject={() => {}}
              onOpenDesignProject={() => {}}
              onOpenGameProject={() => {}}
            />
            <ProjectSharingDialog />
            <RemoveFromTeamDialog />
            <TeamMembersDialog />
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush(10);

    // Unified grid renders Motion, Design, Game with clear Sharing badges.
    const motionCard = container.querySelector('[data-testid="project-card-motion_1"]')!;
    const designCard = container.querySelector('[data-testid="project-card-design_shared"]')!;
    const gameCard = container.querySelector('[data-testid="project-card-game_priv"]')!;
    expect(motionCard.getAttribute('data-share-status')).toBe('personal');
    expect(designCard.getAttribute('data-share-status')).toBe('team_shared');
    expect(designCard.textContent).toContain('Live');
    expect(gameCard.getAttribute('data-share-status')).toBe('team_private');

    // Open TeamMembersDialog from header button.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="projects-collaborators-btn"]')!.click();
    });
    await flush();
    expect(document.body.textContent).toContain('Maya');
    expect(document.body.textContent).toContain('Manage members in Cloud');
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click();
    });
    await flush();

    // Open ProjectSharingDialog on Personal card -> Share to team -> collaborators load -> Remove from team.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="project-share-btn-motion_1"]')!.click();
    });
    await flush(10);
    expect(document.body.querySelector('[data-testid="project-sharing-status"]')!.textContent).toContain('Personal');

    const shareToTeamBtn = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      b => b.textContent?.trim() === 'Share to team',
    )!;
    await act(async () => {
      shareToTeamBtn.click();
    });
    await flush(10);

    expect(document.body.querySelector('[data-testid="project-sharing-status"]')!.textContent).toContain('Shared with Studio Team');
    expect(container.querySelector('[data-testid="project-card-motion_1"]')!.getAttribute('data-share-status')).toBe('team_shared');

    const removeBtn = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      b => b.textContent?.trim() === 'Remove from team',
    )!;
    await act(async () => {
      removeBtn.click();
    });
    await flush();

    expect(document.body.textContent).toContain('Remove from Studio Team?');
    const confirmRemoveBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.om-collab-dialog-footer button')].find(
      b => b.textContent?.includes('Remove from team'),
    )!;
    await act(async () => {
      confirmRemoveBtn.click();
    });
    await flush(10);

    expect(container.querySelector('[data-testid="project-card-motion_1"]')!.getAttribute('data-share-status')).toBe('personal');
  });

  it('scales ProjectsPage workspace/type/sort dropdown menus across multiple teams, trash toggle, and active filter chips', async () => {
    const teamOne = makeWorkspace({ workspaceId: 'ws_team_1', workspaceName: 'Alpha Studio', isDefault: false });
    const teamTwo = makeWorkspace({ workspaceId: 'ws_team_2', workspaceName: 'Brand Crew', isDefault: false });
    const teamThree = makeWorkspace({ workspaceId: 'ws_team_3', workspaceName: 'Client Desk', isDefault: false });
    const snapshot = makeSnapshot({
      activeWorkspace: teamOne,
      workspaces: [
        makeWorkspace({
          workspaceId: 'ws_personal',
          workspaceName: 'Personal',
          workspaceType: 'personal',
          isDefault: true,
        }),
        teamOne,
        teamTwo,
        teamThree,
      ],
    });

    const catalogPayload = {
      activeWorkspaceId: 'ws_team_1',
      activeWorkspaceName: 'Alpha Studio',
      activeWorkspaceType: 'team',
      projects: [
        {
          id: 'p_zeta',
          kind: 'motion',
          title: 'Zeta Intro Reel',
          updatedAt: 2000,
          shareStatus: 'team_shared',
          workspaceId: 'ws_team_1',
          workspaceName: 'Alpha Studio',
          visibility: 'workspace',
          isOwner: true,
          webPublish: { status: 'none' },
          permissions: {
            canOpen: true,
            canShareToTeam: false,
            canChangeVisibility: true,
            canRemoveFromTeam: true,
            canRename: true,
            canDelete: true,
          },
        },
        {
          id: 'p_alpha',
          kind: 'design',
          scenario: 'deck',
          title: 'Alpha Q4 Keynote',
          updatedAt: 3000,
          shareStatus: 'team_shared',
          workspaceId: 'ws_team_2',
          workspaceName: 'Brand Crew',
          visibility: 'workspace',
          isOwner: true,
          webPublish: { status: 'published', url: 'https://open-design.ai/deck' },
          permissions: {
            canOpen: true,
            canShareToTeam: false,
            canChangeVisibility: true,
            canRemoveFromTeam: true,
            canRename: true,
            canDelete: true,
          },
        },
        {
          id: 'p_beta',
          kind: 'game',
          title: 'Beta Arcade',
          previewUrl: 'cover.png',
          updatedAt: 1000,
          shareStatus: 'personal',
          workspaceId: 'ws_personal',
          workspaceName: 'Personal',
          visibility: 'private',
          isOwner: true,
          webPublish: { status: 'none' },
          permissions: {
            canOpen: true,
            canShareToTeam: true,
            canChangeVisibility: false,
            canRemoveFromTeam: false,
            canRename: true,
            canDelete: true,
          },
        },
      ],
      trashed: [
        {
          id: 'p_trash',
          kind: 'motion',
          title: 'Archived Cut',
          updatedAt: 500,
          trashed: true,
          shareStatus: 'personal',
          workspaceId: 'ws_personal',
          workspaceName: 'Personal',
          visibility: 'private',
          isOwner: true,
          webPublish: { status: 'none' },
          permissions: {
            canOpen: false,
            canShareToTeam: false,
            canChangeVisibility: false,
            canRemoveFromTeam: false,
            canRename: false,
            canDelete: true,
          },
        },
      ],
      counts: {
        total: 3,
        personal: 1,
        teamShared: 2,
        teamPrivate: 0,
        motion: 1,
        design: 1,
        game: 1,
        trashed: 1,
      },
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/motion-api/workspace/collab')) return jsonResponse(snapshot);
      if (url.endsWith('/motion-api/workspace/projects')) return jsonResponse(catalogPayload);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <ProjectsPage
              onOpenMotionProject={() => {}}
              onOpenDesignProject={() => {}}
              onOpenGameProject={() => {}}
            />
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush(10);

    expect(container.querySelectorAll('[data-testid^="project-card-"]')).toHaveLength(3);

    // Game relative cover resolves to /motion-api/games/<id>/play/<cover> and falls back cleanly on error.
    const betaCard = container.querySelector('[data-testid="project-card-p_beta"]')!;
    const betaImg = betaCard.querySelector<HTMLImageElement>('img.om-projects-card-preview-img')!;
    expect(betaImg.getAttribute('src')).toBe('/motion-api/games/p_beta/play/cover.png');
    await act(async () => {
      betaImg.dispatchEvent(new Event('error'));
    });
    expect(betaCard.querySelector('[data-kind="game"] .om-projects-art-emblem')).not.toBeNull();

    // Open Workspace dropdown -> lists all 3 teams + selects Brand Crew.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="projects-workspace-filter"]')!.click();
    });
    await flush();
    const wsText = document.body.textContent ?? '';
    expect(wsText).toContain('Alpha Studio');
    expect(wsText).toContain('Brand Crew');
    expect(wsText).toContain('Client Desk');

    const brandCrewRadio = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(el =>
      el.textContent?.includes('Brand Crew'),
    )!;
    await act(async () => {
      brandCrewRadio.click();
    });
    await flush();

    expect(container.querySelectorAll('[data-testid^="project-card-"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="project-card-p_alpha"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="projects-active-filters"]')?.textContent).toContain('Brand Crew');

    // Clear filters restores all 3 cards.
    const clearBtn = [...container.querySelectorAll<HTMLButtonElement>('.om-projects-clear-btn')][0]!;
    await act(async () => {
      clearBtn.click();
    });
    await flush();
    expect(container.querySelectorAll('[data-testid^="project-card-"]')).toHaveLength(3);

    // Open Type dropdown -> select Motion -> only Motion card remains.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="projects-type-filter"]')!.click();
    });
    await flush();
    const motionRadio = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(el =>
      el.textContent?.includes('Motion'),
    )!;
    await act(async () => {
      motionRadio.click();
    });
    await flush();
    expect(container.querySelectorAll('[data-testid^="project-card-"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="project-card-p_zeta"]')).not.toBeNull();

    // Sort Name (A-Z) after clearing type filter orders cards alphabetically.
    container.querySelector<HTMLButtonElement>('.om-projects-clear-btn')!.click();
    await flush();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="projects-sort-filter"]')!.click();
    });
    await flush();
    const nameRadio = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(el =>
      el.textContent?.includes('Name (A–Z)'),
    )!;
    await act(async () => {
      nameRadio.click();
    });
    await flush();
    const sortedTitles = [...container.querySelectorAll<HTMLElement>('.om-projects-card-title-btn')].map(el =>
      el.textContent?.trim(),
    );
    expect(sortedTitles).toEqual(['Alpha Q4 Keynote', 'Beta Arcade', 'Zeta Intro Reel']);

    // Toggle Trash button shows trashed project and removes workspace dropdown while active.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="projects-trash-btn"]')!.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="project-card-p_trash"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="projects-workspace-filter"]')).toBeNull();
  });

  it('opens referral link exactly once even when window.open with noopener returns null', async () => {
    const snapshot = makeSnapshot({
      referral: {
        available: true,
        referralUrl: 'https://open-design.ai/cloud/reset?entry_source=client_entry&expectedAppUserId=usr_1',
        referralCode: 'ELIX5',
        resetCardsAvailable: 2,
        invitedCount: 2,
        inviteTarget: 5,
        inviteeWindowActive: false,
        inviteeWindowEndsAt: null,
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/motion-api/workspace/collab')) return jsonResponse(snapshot);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    // Per the HTML spec, window.open with `noopener` always returns `null` even on success.
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <ReferralEntryCard />
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();

    const btn = container.querySelector<HTMLButtonElement>('[data-testid="referral-entry-card"] button')!;
    await act(async () => {
      btn.click();
    });
    await flush();

    expect(openSpy).toHaveBeenCalledTimes(1);
    const openedUrl = new URL(String(openSpy.mock.calls[0]?.[0]));
    expect(openedUrl.pathname).toBe('/cloud/reset');
    expect(openedUrl.searchParams.get('od_origin')).toBe('openmotion');
    expect(openedUrl.searchParams.get('od_entry_source')).toBe('openmotion_manage_subscription');
    expect(openedUrl.searchParams.get('utm_source')).toBe('openmotion');
    expect(openedUrl.searchParams.get('utm_medium')).toBe('workspace_referral');
    expect(openedUrl.searchParams.has('source')).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/cloud-link'))).toBe(false);
    openSpy.mockRestore();
  });

  it('runs single-flight 5s top-up polling for Owner, auto-recovers on focus or tick, and hides payment CTAs for Members', async () => {
    vi.useFakeTimers();
    let preflightCalls = 0;
    let funded = false;
    const onRecovered = vi.fn();

    const depletedSnapshot = makeSnapshot({
      activeWorkspace: makeWorkspace({ workspaceId: 'ws_team_1', role: 'owner', planId: 'free' }),
      workspaces: [
        makeWorkspace({
          workspaceId: 'ws_personal',
          workspaceName: 'Personal',
          workspaceType: 'personal',
          role: 'owner',
          isDefault: true,
          planId: 'free',
        }),
        makeWorkspace({ workspaceId: 'ws_team_1', role: 'owner', planId: 'free' }),
      ],
      permissions: buildWorkspacePermissions({
        workspaceType: 'team',
        role: 'owner',
        lifecycleState: 'active',
        memberStatus: 'active',
      }),
      quota: {
        workspaceId: 'ws_team_1',
        planId: 'free',
        planLabel: 'Free',
        billingState: 'free',
        lifecycleState: 'active',
        weeklyPercentLeft: 0,
        weeklyResetsAt: null,
        weeklyLimitExhausted: true,
        creditsUsd: '0.00',
        creditsExhausted: true,
        hasAvailableFunds: false,
      },
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/workspace/collab/preflight')) {
        preflightCalls++;
        return jsonResponse({
          funded,
          reason: funded ? 'ok' : 'insufficient_balance',
          workspaceId: 'ws_team_1',
          workspaceName: 'Studio Team',
          workspaceType: 'team',
          planId: funded ? 'plus' : 'free',
          planLabel: funded ? 'Plus' : 'Free',
          balanceUsd: funded ? '25.00' : '0.00',
          weeklyPercentLeft: funded ? 100 : 0,
          weeklyResetsAt: null,
          audience: 'owner',
          source: 'vela-preflight',
          checkedAt: Date.now(),
        });
      }
      if (url.includes('/workspace/collab/cloud-link')) {
        return jsonResponse({ url: 'https://open-design.ai/cloud/dashboard?workspaceId=ws_team_1', opened: true });
      }
      return jsonResponse(depletedSnapshot);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('open', vi.fn(() => null));

    function Harness() {
      const collab = useWorkspaceCollab();
      return (
        <>
          <button
            type="button"
            data-testid="open-balance"
            onClick={() =>
              collab.setBillingGate({
                kind: 'balance',
                reason: 'insufficient_balance',
                balanceUsd: '0.00',
                weeklyPercentLeft: 0,
                onRecovered,
              })
            }
          >
            open
          </button>
          <BillingGateDialog />
        </>
      );
    }

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <Harness />
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-balance"]')?.click();
    });
    await flush();

    const dialog = document.body.querySelector('[data-testid="balance-gate-dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('$0.00');
    const topUpBtn = Array.from(document.body.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Upgrade or top up'),
    )!;
    expect(topUpBtn).toBeTruthy();

    await act(async () => {
      topUpBtn.click();
    });
    await flush();
    expect(document.body.querySelector('[data-testid="balance-gate-polling"]')).toBeTruthy();

    // First 5s tick returns funded=false -> dialog remains open
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flush();
    expect(preflightCalls).toBe(1);
    expect(document.body.querySelector('[data-testid="balance-gate-dialog"]')).toBeTruthy();

    // Balance recovers on next 5s tick -> dialog closes + onRecovered fires + toast displays
    funded = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flush();
    expect(preflightCalls).toBe(2);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="balance-gate-dialog"]')).toBeNull();
    expect(document.body.textContent).toContain('Credits restored. You can continue now.');

    // No further polling ticks fire once recovered
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(preflightCalls).toBe(2);
    vi.useRealTimers();

    // Render as non-owner Member: payment CTA must be hidden
    const memberSnapshot = makeSnapshot({
      ...depletedSnapshot,
      activeWorkspace: makeWorkspace({ workspaceId: 'ws_team_1', role: 'member', planId: 'free' }),
      workspaces: [
        depletedSnapshot.workspaces[0],
        makeWorkspace({ workspaceId: 'ws_team_1', role: 'member', planId: 'free' }),
      ],
      permissions: buildWorkspacePermissions({
        workspaceType: 'team',
        role: 'member',
        lifecycleState: 'active',
        memberStatus: 'active',
      }),
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(memberSnapshot)));
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider key="member-depleted">
            <Harness />
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-balance"]')?.click();
    });
    await flush();
    expect(document.body.querySelector('[data-testid="balance-gate-member-notice"]')).toBeTruthy();
    expect(
      Array.from(document.body.querySelectorAll('button')).some(b =>
        b.textContent?.includes('Upgrade or top up'),
      ),
    ).toBe(false);
    expect(
      Array.from(document.body.querySelectorAll('button')).some(b =>
        b.textContent?.includes('Switch to personal'),
      ),
    ).toBe(true);
  });

  it('renders ConcurrencyGateDialog tiers cleanly for Non-Max Owner, Max Owner, and Team Member', async () => {
    const renderTier = async (role: 'owner' | 'member', planId: string) => {
      const snap = makeSnapshot({
        activeWorkspace: makeWorkspace({ role, planId }),
        permissions: buildWorkspacePermissions({
          workspaceType: 'team',
          role,
          lifecycleState: 'active',
          memberStatus: 'active',
        }),
        quota: {
          workspaceId: 'ws_team_1',
          planId,
          planLabel: planId.toUpperCase(),
          billingState: 'active',
          lifecycleState: 'active',
          weeklyPercentLeft: 80,
          weeklyResetsAt: null,
          weeklyLimitExhausted: false,
          creditsUsd: '50.00',
          creditsExhausted: false,
          hasAvailableFunds: true,
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes('/workspace/collab/concurrency')) {
            return jsonResponse({
              available: true,
              workspaceId: 'ws_team_1',
              planId,
              planLabel: planId,
              inFlight: 3,
              limit: 3,
              audience: role,
              isMaxPlan: planId === 'max',
              checkedAt: Date.now(),
            });
          }
          return jsonResponse(snap);
        }),
      );
      function Harness() {
        const collab = useWorkspaceCollab();
        return (
          <>
            <button
              type="button"
              data-testid="trigger-conc"
              onClick={() => void collab.handleBillingError('tier_limit_exceeded')}
            >
              conc
            </button>
            <BillingGateDialog />
          </>
        );
      }
      await act(async () => {
        root.render(
          <I18nProvider initialLocale="en">
            <WorkspaceCollabProvider key={`${role}-${planId}`}>
              <Harness />
            </WorkspaceCollabProvider>
          </I18nProvider>,
        );
      });
      await flush();
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="trigger-conc"]')?.click();
      });
      await flush();
    };

    // 1. Non-Max Owner sees slot count & Upgrade plan
    await renderTier('owner', 'plus');
    const nonMax = document.body.querySelector('[data-testid="concurrency-gate-dialog"]')!;
    expect(nonMax.textContent).toContain('3 / 3 active tasks');
    expect(nonMax.textContent).toContain('Higher parallel task limit');
    expect(
      Array.from(document.body.querySelectorAll('button')).some(b => b.textContent?.includes('Upgrade plan')),
    ).toBe(true);

    // 2. Max Owner has zero Upgrade CTA
    await renderTier('owner', 'max');
    const maxDlg = document.body.querySelector('[data-testid="concurrency-gate-dialog"]')!;
    expect(maxDlg.textContent).toContain('Max plan');
    expect(
      Array.from(document.body.querySelectorAll('button')).some(b => b.textContent?.includes('Upgrade plan')),
    ).toBe(false);

    // 3. Team Member has zero Upgrade CTA
    await renderTier('member', 'plus');
    const memberDlg = document.body.querySelector('[data-testid="concurrency-gate-dialog"]')!;
    expect(memberDlg.textContent).toContain('ask your workspace owner');
    expect(
      Array.from(document.body.querySelectorAll('button')).some(b => b.textContent?.includes('Upgrade plan')),
    ).toBe(false);
  });

  it('shows ArtifactUpgradeDialog once per 24h cooldown on Free/Go delivery and suppresses it on Plus', async () => {
    resetArtifactUpgradeCooldown();
    const freePersonal = makeSnapshot({
      activeWorkspace: makeWorkspace({ workspaceId: 'ws_p', workspaceType: 'personal', role: 'owner', planId: 'free' }),
      workspaces: [makeWorkspace({ workspaceId: 'ws_p', workspaceType: 'personal', role: 'owner', planId: 'free', isDefault: true })],
      quota: {
        workspaceId: 'ws_p',
        planId: 'free',
        planLabel: 'Free',
        billingState: 'free',
        lifecycleState: 'active',
        weeklyPercentLeft: 100,
        weeklyResetsAt: null,
        weeklyLimitExhausted: false,
        creditsUsd: '2.00',
        creditsExhausted: false,
        hasAvailableFunds: true,
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(freePersonal)));
    const openSpy = vi.fn(() => null);
    vi.stubGlobal('open', openSpy);

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider key="free-personal">
            <BillingGateDialog />
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();

    act(() => {
      emitArtifactDelivered({ kind: 'media', label: 'Hero Clip' });
    });
    await flush();

    const dlg = document.body.querySelector('[data-testid="artifact-upgrade-dialog"]')!;
    expect(dlg).toBeTruthy();
    expect(dlg.textContent).toContain('Images');
    expect(dlg.textContent).toContain('Video');
    expect(dlg.textContent).toContain('Voiceover');
    expect(dlg.textContent).toContain('Music');

    const upgradeBtn = Array.from(document.body.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Upgrade plan'),
    )!;
    await act(async () => {
      upgradeBtn.click();
    });
    await flush();
    expect(openSpy).toHaveBeenCalledTimes(1);
    const upgradeUrl = new URL(String(openSpy.mock.calls[0]?.[0]));
    expect(upgradeUrl.searchParams.get('utm_medium')).toBe('artifact_upgrade');
    expect(upgradeUrl.searchParams.get('od_entry_source')).toBe('openmotion_manage_subscription');

    // Second emission within 24h cooldown does not reopen dialog
    act(() => {
      emitArtifactDelivered({ kind: 'export', label: 'Final Render' });
    });
    await flush();
    expect(document.body.querySelector('[data-testid="artifact-upgrade-dialog"]')).toBeNull();

    // Plus plan never opens post-artifact upsell even after cooldown reset
    resetArtifactUpgradeCooldown();
    const plusPersonal = makeSnapshot({
      ...freePersonal,
      quota: { ...freePersonal.quota!, planId: 'plus', planLabel: 'Plus' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(plusPersonal)));
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider key="plus-personal">
            <BillingGateDialog />
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();
    act(() => {
      emitArtifactDelivered({ kind: 'deliverable', label: 'Deck' });
    });
    await flush();
    expect(document.body.querySelector('[data-testid="artifact-upgrade-dialog"]')).toBeNull();
    openSpy.mockRestore();
  });

  it('switches workspaces inline inside ApplicationAccountMenu and peeks cached GitHub stars synchronously', async () => {
    localStorage.setItem('openmotion.github-stars', JSON.stringify({ count: 15963, at: Date.now() }));
    expect(peekCachedRepositoryStars()).toBe(15963);

    const personal = makeWorkspace({ workspaceId: 'ws_personal', workspaceName: 'Personal Studio', workspaceType: 'personal' });
    const team = makeWorkspace({ workspaceId: 'ws_team', workspaceName: 'Design Team', workspaceType: 'team', role: 'owner' });
    let active = personal;
    const switchCalls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/workspace/collab/switch') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body ?? '{}')) as { workspaceId?: string };
          if (body.workspaceId) switchCalls.push(body.workspaceId);
          active = body.workspaceId === 'ws_team' ? team : personal;
          return jsonResponse(
            makeSnapshot({
              workspaces: [personal, team],
              activeWorkspaceId: active.workspaceId,
              activeWorkspace: active,
              permissions: buildWorkspacePermissions(active),
            }),
          );
        }
        if (url.includes('/settings/account')) {
          return jsonResponse({ state: 'signed-in', user: { name: 'Alex', email: 'alex@example.com' } });
        }
        return jsonResponse(
          makeSnapshot({
            workspaces: [personal, team],
            activeWorkspaceId: active.workspaceId,
            activeWorkspace: active,
            permissions: buildWorkspacePermissions(active),
          }),
        );
      }),
    );

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <ApplicationAccountMenu settings={null} openSettings={() => {}} />
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Account menu"]')!;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger.click();
    });
    await flush();

    const wsSection = document.body.querySelector('[data-testid="account-hub-workspaces"]');
    expect(wsSection).not.toBeNull();
    expect(wsSection?.textContent).toContain('Personal Studio');
    expect(wsSection?.textContent).toContain('Design Team');

    const teamOption = Array.from(wsSection!.querySelectorAll<HTMLButtonElement>('.om-account-hub-ws-item')).find(
      btn => btn.textContent?.includes('Design Team'),
    )!;
    expect(teamOption).not.toBeNull();
    await act(async () => {
      teamOption.click();
    });
    await flush();

    expect(switchCalls).toEqual(['ws_team']);
    localStorage.removeItem('openmotion.github-stars');
  });
});
