// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCollabSnapshot, WorkspaceDirectoryEntry } from '../../../../shared/workspace-collab';
import { buildWorkspacePermissions } from '../../../../shared/workspace-collab';
import { WebPublishPopover } from '../../components/WebPublishPopover';
import { I18nProvider } from '../../i18n/I18n';
import { WorkspaceCollabProvider, useWorkspaceCollab } from '../WorkspaceCollabContext';
import { CommentSyncBanner } from './CommentSyncBanner';
import { HeaderInviteTrigger, InviteMembersDialog } from './InviteMembersDialog';
import { MoveToTeamDialog } from './MoveToTeamDialog';
import { ProjectScopeTabs, filterProjectsByScope } from './ProjectScopeTabs';
import { ReferralEntryCard } from './ReferralEntryCard';
import { BillingGateDialog, UpgradeCard } from './UpgradeCard';
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
      [{ id: 'p1' }, { id: 't1' }],
      'team',
      { t1: { workspaceId: 'ws_team_1' } },
      new Set(['ws_personal']),
      new Set(['ws_team_1']),
    );
    expect(scoped.map(p => p.id)).toEqual(['t1']);

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
});
