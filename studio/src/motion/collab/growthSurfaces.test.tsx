// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageCenterMessage, ProductionTouchpointDecision } from '../../../../shared/growth-surfaces';
import type { WorkspaceCollabSnapshot, WorkspaceDirectoryEntry } from '../../../../shared/workspace-collab';
import { buildWorkspacePermissions, EMPTY_WORKSPACE_PERMISSIONS } from '../../../../shared/workspace-collab';
import { I18nProvider } from '../../i18n/I18n';
import { setMotionTrackingEnabled } from '../tracking';
import { WorkspaceCollabProvider } from '../WorkspaceCollabContext';
import { emitArtifactDelivered } from './artifactDeliveryBus';
import { ExperienceSurveyCard } from './ExperienceSurveyCard';
import { isSurveyRetired, resetExperienceSurveyForTest } from './experienceSurveyState';
import { GrowthSurfacesProvider, useGrowthSurfaces } from './GrowthSurfacesContext';
import { MessageCenterPopover } from './MessageCenterPopover';
import { PriorityAnnouncementDialog } from './PriorityAnnouncementDialog';
import { ProductionCampaignBadge } from './ProductionCampaignBadge';
import { ProductionCampaignModal } from './ProductionCampaignModal';
import { SocialShareCard } from './SocialShareCard';
import { SupportDialog } from './SupportDialog';
import { WhatsNewCard } from './WhatsNewCard';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush(ticks = 8) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function makeWorkspace(overrides: Partial<WorkspaceDirectoryEntry> = {}): WorkspaceDirectoryEntry {
  return {
    workspaceId: 'ws_team_1',
    workspaceName: 'Acme Studio',
    workspaceType: 'team',
    workspaceMemberId: 'mem_1',
    role: 'owner',
    isDefault: false,
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: 'plus',
    memberCount: 3,
    ...overrides,
  };
}

function makeCollabSnapshot(planId = 'plus', signedIn = true): WorkspaceCollabSnapshot {
  const active = makeWorkspace({ planId, billingState: planId === 'free' ? 'free' : 'active' });
  return {
    signedIn,
    accountState: signedIn ? 'signed-in' : 'signed-out',
    user: signedIn ? { name: 'Eli', email: 'eli@example.com' } : undefined,
    workspaces: signedIn ? [active] : [],
    activeWorkspaceId: signedIn ? active.workspaceId : null,
    activeWorkspace: signedIn ? active : null,
    permissions: signedIn ? buildWorkspacePermissions(active) : EMPTY_WORKSPACE_PERMISSIONS,
    removedFromWorkspace: null,
    quota: signedIn
      ? {
          workspaceId: active.workspaceId,
          planId,
          planLabel: planId === 'free' ? 'Free' : 'Plus',
          billingState: planId === 'free' ? 'free' : 'active',
          lifecycleState: active.lifecycleState,
          creditsUsd: '42.00',
          weeklyPercentLeft: 95,
          weeklyResetsAt: null,
          hasAvailableFunds: true,
          weeklyLimitExhausted: false,
          creditsExhausted: false,
        }
      : null,
    referral: null,
    projectMeta: {},
    commentSync: {},
    preferences: { skipMoveToTeamConfirm: false, dismissedBanners: [] },
  };
}

function makeDecision(
  placementKey: 'opend.home.account-badge' | 'opend.home.campaign-modal',
  overrides: Partial<ProductionTouchpointDecision> = {},
): ProductionTouchpointDecision {
  return {
    activityId: 'act_ds_flash',
    touchpointDecisionId: `dec_${placementKey}`,
    deploymentId: 'dep_1',
    placementKey,
    endsAt: new Date(Date.now() + 3600_000).toISOString(),
    badgeLabel: 'Flash Deal',
    title: 'DeepSeek V4.1 Flash is live',
    subtitle: 'Limited-time production launch',
    body: 'Generate scenes faster across all projects.',
    highlights: ['Included with Plus plans', 'Zero setup needed'],
    paidCtaLabel: 'Use DeepSeek V4.1 Flash',
    freeCtaLabel: 'Upgrade plan',
    ctaUrl: 'https://open-design.ai/pricing',
    targetModelId: 'deepseek-v4-flash',
    targetModelLabel: 'DeepSeek V4.1 Flash',
    ...overrides,
  };
}

describe('Phase B growth surfaces', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    container.dataset.motionStudio = 'true';
    document.body.appendChild(container);
    localStorage.clear();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('MessageCenterPopover displays unread badge, supports read/mark-all, archive/restore, and error retry', async () => {
    let feedMessages: MessageCenterMessage[] = [
      {
        id: 'm1',
        audienceType: 'global',
        typeName: 'release',
        title: 'First release notice',
        body: 'New team sharing controls are live.',
        ctaLabel: 'Read more',
        ctaUrl: 'https://open-design.ai/changelog',
        publishedAt: '2026-11-24T10:00:00Z',
        readAt: null,
      },
      {
        id: 'm2',
        audienceType: 'global',
        typeName: 'update',
        title: 'Second notice',
        body: 'Already read announcement.',
        ctaLabel: null,
        ctaUrl: null,
        publishedAt: '2026-11-23T10:00:00Z',
        readAt: '2026-11-23T11:00:00Z',
      },
    ];
    let failMessages = false;
    const postCalls: string[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/motion-api/workspace/collab')) {
        return jsonResponse(makeCollabSnapshot('plus', true));
      }
      if (url.includes('/motion-api/message-center/messages/') && method === 'POST') {
        postCalls.push(url);
        return jsonResponse({ ok: true });
      }
      if (url.includes('/motion-api/message-center/read-all') && method === 'POST') {
        postCalls.push(url);
        return jsonResponse({ ok: true });
      }
      if (url.includes('/motion-api/message-center/messages')) {
        if (failMessages) return jsonResponse({ error: 'down' }, 502);
        return jsonResponse({ signedIn: true, messages: feedMessages, unreadCount: 1 });
      }
      if (url.includes('/motion-api/touchpoints/production')) {
        return jsonResponse({ status: 'none', decision: null, offlineReplay: false });
      }
      if (url.includes('/motion-api/whats-new')) {
        return jsonResponse({ version: '0.0.1', id: null, content: null });
      }
      return jsonResponse({});
    });

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <GrowthSurfacesProvider isHomeSurface>
              <MessageCenterPopover />
            </GrowthSurfacesProvider>
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();

    // Unread badge shows "1"
    const badge = container.querySelector('[data-testid="message-center-unread"]');
    expect(badge?.textContent).toBe('1');

    // Open Popover
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="message-center-trigger"]')!;
    await act(async () => {
      trigger.click();
    });
    await flush();

    const panel = document.body.querySelector('[data-testid="message-center-panel"]')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelectorAll('[data-testid="message-center-item"]').length).toBe(2);

    // Archiving unread m1 drops badge to 0 and moves m1 to Archived shelf
    const archiveBtn = panel.querySelector<HTMLButtonElement>('.om-message-center-archive-btn')!;
    await act(async () => {
      archiveBtn.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="message-center-unread"]')).toBeNull();
    expect(panel.querySelectorAll('[data-testid="message-center-item"]').length).toBe(1);

    // Switch to Archived tab & restore m1
    const archivedTab = panel.querySelector<HTMLButtonElement>('[data-testid="message-center-tab-archived"]')!;
    await act(async () => {
      archivedTab.click();
    });
    await flush();
    expect(panel.querySelectorAll('[data-testid="message-center-item"]').length).toBe(1);

    const restoreBtn = panel.querySelector<HTMLButtonElement>('.om-message-center-archive-btn')!;
    await act(async () => {
      restoreBtn.click();
    });
    await flush();

    // Switch back to Inbox and click unread item -> marks read optimistically and calls POST .../read
    const inboxTab = panel.querySelector<HTMLButtonElement>('[data-testid="message-center-tab-inbox"]')!;
    await act(async () => {
      inboxTab.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="message-center-unread"]')?.textContent).toBe('1');

    const rowBtn = panel.querySelector<HTMLButtonElement>('.om-message-center-row-btn')!;
    await act(async () => {
      rowBtn.click();
    });
    await flush();
    expect(postCalls.some(u => u.includes('/messages/m1/read'))).toBe(true);
    expect(container.querySelector('[data-testid="message-center-unread"]')).toBeNull();

    // Add 10 unread messages to verify 9+ badge and Mark all read
    feedMessages = Array.from({ length: 10 }, (_, idx) => ({
      id: `bulk_${idx}`,
      audienceType: 'global',
      typeName: 'update',
      title: `Bulk ${idx}`,
      body: 'Body',
      ctaLabel: null,
      ctaUrl: null,
      publishedAt: '2026-11-24T00:00:00Z',
      readAt: null,
    }));
    // Trigger refresh on re-open
    await act(async () => {
      trigger.click();
    });
    await flush();
    await act(async () => {
      trigger.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="message-center-unread"]')?.textContent).toBe('9+');

    const markAllBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="message-center-mark-all"]')!;
    await act(async () => {
      markAllBtn.click();
    });
    await flush();
    expect(postCalls.some(u => u.includes('/read-all'))).toBe(true);
    expect(container.querySelector('[data-testid="message-center-unread"]')).toBeNull();

    // Verify error state when fetch fails on empty store
    failMessages = true;
    await act(async () => {
      root!.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <GrowthSurfacesProvider isHomeSurface>
              <MessageCenterPopover />
            </GrowthSurfacesProvider>
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="message-center-trigger"]')!.click();
    });
    await flush();
    expect(document.body.querySelector('[data-testid="message-center-error"]')).not.toBeNull();
  });

  it('PriorityAnnouncementDialog opens only on Home when unblocked and marks targeted go-plan-sunset message read', async () => {
    const readIds: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/motion-api/workspace/collab')) return jsonResponse(makeCollabSnapshot('free', true));
      if (url.includes('/motion-api/message-center/messages/') && init?.method === 'POST') {
        readIds.push(url);
        return jsonResponse({ ok: true });
      }
      if (url.includes('/motion-api/message-center/messages')) {
        return jsonResponse({
          signedIn: true,
          unreadCount: 1,
          messages: [
            {
              id: 'msg_sunset',
              audienceType: 'targeted',
              messageKey: 'go-plan-sunset-2026-08-cohort',
              typeName: 'billing',
              title: 'Go Plan Sunset Notice',
              body: 'Your Go plan renews as Plus.',
              ctaLabel: 'Review plans',
              ctaUrl: 'https://open-design.ai/pricing',
              publishedAt: '2026-11-24T00:00:00Z',
              readAt: null,
            },
          ],
        });
      }
      if (url.includes('/motion-api/touchpoints/production')) {
        return jsonResponse({ status: 'none', decision: null, offlineReplay: false });
      }
      if (url.includes('/motion-api/whats-new')) {
        return jsonResponse({ version: '0.0.1', id: null, content: null });
      }
      return jsonResponse({});
    });

    root = createRoot(container);
    // Blocked by higherModalOpen -> dialog stays hidden
    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <GrowthSurfacesProvider isHomeSurface higherModalOpen>
              <PriorityAnnouncementDialog />
            </GrowthSurfacesProvider>
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();
    expect(document.body.querySelector('[data-testid="priority-announcement-dialog"]')).toBeNull();

    // Unblock higherModalOpen -> dialog renders cleanly
    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <GrowthSurfacesProvider isHomeSurface higherModalOpen={false}>
              <PriorityAnnouncementDialog />
            </GrowthSurfacesProvider>
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();
    const dialog = document.body.querySelector('[data-testid="priority-announcement-dialog"]');
    expect(dialog).not.toBeNull();

    const ackBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="priority-announcement-ack"]')!;
    await act(async () => {
      ackBtn.click();
    });
    await flush();
    expect(readIds.some(u => u.includes('msg_sunset'))).toBe(true);
    expect(document.body.querySelector('[data-testid="priority-announcement-dialog"]')).toBeNull();
  });

  it('ProductionCampaignBadge and Modal render audience-aware CTAs, fire model action for paid plans, and suppress WhatsNew while modal is active', async () => {
    let planId = 'plus';
    const onUseModel = vi.fn();
    let touchpointStatus: 'active' | 'revoked' = 'active';

    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/motion-api/workspace/collab')) return jsonResponse(makeCollabSnapshot(planId, true));
      if (url.includes('/motion-api/message-center/messages')) {
        return jsonResponse({ signedIn: true, messages: [], unreadCount: 0 });
      }
      if (url.includes('/motion-api/touchpoints/production')) {
        if (touchpointStatus === 'revoked') {
          return jsonResponse({ status: 'revoked', decision: null, offlineReplay: false });
        }
        const placement = url.includes('account-badge')
          ? 'opend.home.account-badge'
          : 'opend.home.campaign-modal';
        return jsonResponse({
          status: 'active',
          decision: makeDecision(placement),
          offlineReplay: false,
        });
      }
      if (url.includes('/motion-api/touchpoints/events')) return jsonResponse({ ok: true });
      if (url.includes('/motion-api/whats-new')) {
        return jsonResponse({
          version: '1.2.3',
          id: 'wn_1',
          content: {
            title: 'Fresh Updates',
            body: 'First update bullet\nSecond update bullet',
            ctaLabel: 'Explore',
            linkUrl: 'https://github.com/openmotion-ai/openmotion/releases',
          },
        });
      }
      return jsonResponse({});
    });

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <GrowthSurfacesProvider isHomeSurface onUseCampaignModel={onUseModel}>
              <ProductionCampaignBadge />
              <ProductionCampaignModal />
              <WhatsNewCard />
            </GrowthSurfacesProvider>
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();

    // Paid plan sees Use DeepSeek V4.1 Flash (NOT upgrade), and WhatsNew yields slot while campaign modal is open
    const badge = container.querySelector<HTMLButtonElement>('[data-testid="touchpoint-campaign-badge"]');
    expect(badge?.textContent).toContain('Flash Deal');
    const primaryCta = document.body.querySelector<HTMLButtonElement>('[data-testid="touchpoint-campaign-primary-cta"]')!;
    expect(primaryCta.textContent).toContain('Use DeepSeek V4.1 Flash');
    expect(document.body.querySelector('[data-testid="whats-new-card"]')).toBeNull();

    // Clicking primary CTA invokes onUseCampaignModel, closes campaign modal, and unblocks WhatsNewCard
    await act(async () => {
      primaryCta.click();
    });
    await flush();
    expect(onUseModel).toHaveBeenCalledWith('deepseek-v4-flash', 'DeepSeek V4.1 Flash');
    expect(document.body.querySelector('[data-testid="touchpoint-campaign-modal"]')).toBeNull();
    const whatsNew = container.querySelector('[data-testid="whats-new-card"]');
    expect(whatsNew).not.toBeNull();
    expect(whatsNew?.textContent).toContain('First update bullet');

    // Dismissing WhatsNewCard stores id in localStorage so remount does not show again
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="whats-new-dismiss"]')!.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="whats-new-card"]')).toBeNull();

    // Free plan opens modal manually via badge and sees Upgrade plan CTA (once-per-activity auto-open does not repeat)
    planId = 'free';
    await act(async () => {
      root!.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <GrowthSurfacesProvider isHomeSurface>
              <ProductionCampaignBadge />
              <ProductionCampaignModal />
              <WhatsNewCard />
            </GrowthSurfacesProvider>
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();
    expect(document.body.querySelector('[data-testid="touchpoint-campaign-modal"]')).toBeNull();
    expect(container.querySelector('[data-testid="whats-new-card"]')).toBeNull();

    // Manual badge click opens Free user Upgrade CTA
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="touchpoint-campaign-badge"]')!.click();
    });
    await flush();
    expect(
      document.body.querySelector('[data-testid="touchpoint-campaign-primary-cta"]')?.textContent,
    ).toContain('Upgrade plan');

    // Simulate 410 revocation response -> next visibility refresh removes badge and modal immediately
    touchpointStatus = 'revoked';
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(container.querySelector('[data-testid="touchpoint-campaign-badge"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="touchpoint-campaign-modal"]')).toBeNull();
  });
});

function SupportTriggerHarness() {
  const growth = useGrowthSurfaces();
  return (
    <button
      type="button"
      data-testid="open-support-btn"
      onClick={() =>
        growth.openSupportDialog({
          summary: 'Render timed out cleanly',
          detail: 'video · job_42',
          source: 'Media generator',
        })
      }
    >
      Open support
    </button>
  );
}

describe('Phase C retention, support, and social share surfaces', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let originalDnt: PropertyDescriptor | undefined;
  let originalClipboard: PropertyDescriptor | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    container.dataset.motionStudio = 'true';
    document.body.appendChild(container);
    localStorage.clear();
    resetExperienceSurveyForTest();
    originalDnt = Object.getOwnPropertyDescriptor(window.navigator, 'doNotTrack');
    originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
    Object.defineProperty(window.navigator, 'doNotTrack', {
      configurable: true,
      value: '0',
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
    document.body.innerHTML = '';
    localStorage.clear();
    resetExperienceSurveyForTest();
    setMotionTrackingEnabled(false);
    if (originalDnt) {
      Object.defineProperty(window.navigator, 'doNotTrack', originalDnt);
    } else {
      Reflect.deleteProperty(window.navigator, 'doNotTrack');
    }
    if (originalClipboard) {
      Object.defineProperty(window.navigator, 'clipboard', originalClipboard);
    }
    vi.restoreAllMocks();
  });

  it('suppresses ExperienceSurveyCard when tracking is disabled or DO_NOT_TRACK is set', async () => {
    setMotionTrackingEnabled(false);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/motion-api/tracking')) return jsonResponse({ enabled: false });
      if (url.includes('/motion-api/workspace/collab')) return jsonResponse(makeCollabSnapshot('plus'));
      return jsonResponse({});
    });

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <WorkspaceCollabProvider>
            <GrowthSurfacesProvider surveyDelayMs={10}>
              <ExperienceSurveyCard />
            </GrowthSurfacesProvider>
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();

    await act(async () => {
      emitArtifactDelivered({ kind: 'deliverable', label: 'Disabled run' });
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    await flush();
    expect(container.querySelector('[data-testid="experience-survey-card"]')).toBeNull();
    expect(isSurveyRetired()).toBe(false);

    // Even when enabled in app config, navigator.doNotTrack === '1' suppresses the survey
    Object.defineProperty(window.navigator, 'doNotTrack', { configurable: true, value: '1' });
    setMotionTrackingEnabled(true);
    await act(async () => {
      emitArtifactDelivered({ kind: 'export', label: 'DNT run' });
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    await flush();
    expect(container.querySelector('[data-testid="experience-survey-card"]')).toBeNull();
    expect(isSurveyRetired()).toBe(false);
  });

  it('shows ExperienceSurveyCard once after delivery, arbitrates against higher modals, submits telemetry, and retires permanently', async () => {
    setMotionTrackingEnabled(true);
    const trackedBatches: Array<{ events?: Array<{ event: string; properties?: Record<string, unknown> }> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/motion-api/tracking')) {
        if (init?.method === 'POST' && typeof init.body === 'string') {
          trackedBatches.push(JSON.parse(init.body));
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ enabled: true });
      }
      if (url.includes('/motion-api/workspace/collab')) return jsonResponse(makeCollabSnapshot('plus'));
      return jsonResponse({});
    });

    const renderWithHigherModal = (higherModalOpen: boolean) => (
      <I18nProvider initialLocale="en">
        <WorkspaceCollabProvider>
          <GrowthSurfacesProvider higherModalOpen={higherModalOpen} surveyDelayMs={10}>
            <ExperienceSurveyCard />
          </GrowthSurfacesProvider>
        </WorkspaceCollabProvider>
      </I18nProvider>
    );

    root = createRoot(container);
    await act(async () => {
      root!.render(renderWithHigherModal(true));
    });
    await flush();

    // Deliver while higher modal is open -> armed but suppressed visually
    await act(async () => {
      emitArtifactDelivered({ kind: 'deliverable', label: 'Hero Showcase' });
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    await flush();
    expect(container.querySelector('[data-testid="experience-survey-card"]')).toBeNull();

    // Clear higherModalOpen -> survey appears and permanently retires on first show
    await act(async () => {
      root!.render(renderWithHigherModal(false));
    });
    await flush();

    const card = container.querySelector('[data-testid="experience-survey-card"]');
    expect(card).not.toBeNull();
    expect(isSurveyRetired()).toBe(true);

    // Step 1 -> select score 9
    const scoreBtn = card!.querySelector<HTMLButtonElement>('button[aria-label="9"]');
    expect(scoreBtn).not.toBeNull();
    await act(async () => {
      scoreBtn!.click();
    });
    await flush();
    expect(card!.textContent).toContain('Score: 9/10');

    // Step 2 -> pick improvement chip + enter bounded feedback + submit
    const qualityBtn = Array.from(card!.querySelectorAll<HTMLButtonElement>('button.om-survey-chip')).find(
      b => b.textContent?.includes('Visual quality'),
    );
    expect(qualityBtn).not.toBeNull();
    await act(async () => {
      qualityBtn!.click();
    });
    const textarea = card!.querySelector<HTMLTextAreaElement>('textarea.om-survey-textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, 'Loved the timeline lighting');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(card!.textContent).toContain('27/240');

    const submitBtn = card!.querySelector<HTMLButtonElement>('button.om-survey-submit-btn')!;
    await act(async () => {
      submitBtn.click();
    });
    await flush();
    expect(card!.textContent).toContain('Thank you for your feedback!');

    const surveyEvents = trackedBatches.flatMap(b => b.events ?? []).filter(e => e.event === 'experience_survey_event');
    expect(surveyEvents.some(e => e.properties?.action === 'shown' && e.properties?.trigger === 'post_deliverable')).toBe(true);
    expect(
      surveyEvents.some(
        e =>
          e.properties?.action === 'submitted' &&
          e.properties?.score === 9 &&
          e.properties?.improvement === 'visual_quality' &&
          e.properties?.feedback_text === 'Loved the timeline lighting',
      ),
    ).toBe(true);

    // Second delivery + remount stays permanently retired
    await act(async () => {
      root!.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(renderWithHigherModal(false));
    });
    await flush();
    await act(async () => {
      emitArtifactDelivered({ kind: 'media', label: 'Follow-up video' });
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    await flush();
    expect(container.querySelector('[data-testid="experience-survey-card"]')).toBeNull();
  });

  it('SupportDialog renders error context, copies formatted details, and orders community channels by locale', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/motion-api/workspace/collab')) return jsonResponse(makeCollabSnapshot('plus'));
      return jsonResponse({});
    });

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="zh-CN">
          <WorkspaceCollabProvider>
            <GrowthSurfacesProvider>
              <SupportTriggerHarness />
              <SupportDialog />
            </GrowthSurfacesProvider>
          </WorkspaceCollabProvider>
        </I18nProvider>,
      );
    });
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-support-btn"]')!.click();
    });
    await flush();

    const errorCtx = document.body.querySelector('[data-testid="support-error-context"]');
    expect(errorCtx).not.toBeNull();
    expect(errorCtx?.textContent).toContain('Render timed out cleanly');
    expect(errorCtx?.textContent).toContain('video · job_42');

    const copyBtn = document.body.querySelector<HTMLButtonElement>('.om-support-copy-btn')!;
    await act(async () => {
      copyBtn.click();
    });
    await flush();
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('[Media generator]\nRender timed out cleanly\nvideo · job_42\nLocale: zh-CN'),
    );

    const channels = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.om-support-channel-btn'));
    expect(channels).toHaveLength(3);
    // zh-CN prioritizes Feishu first
    expect(channels[0].textContent).toContain('飞书');
    await act(async () => {
      channels[0].click();
    });
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining('feishu.cn'), '_blank', 'noopener,noreferrer');
  });

  it('SocialShareCard copies social caption and opens platform share intent links', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onNotify = vi.fn();
    const onShared = vi.fn();

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <SocialShareCard
            title="Launch Teaser"
            shareUrl="https://open-design.ai/share/teaser"
            onNotify={onNotify}
            onShared={onShared}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const card = container.querySelector('[data-testid="social-share-card"]')!;
    const platformButtons = Array.from(card.querySelectorAll<HTMLButtonElement>('.om-social-share-btn'));
    expect(platformButtons.map(b => b.dataset.platform)).toEqual(['x', 'linkedin', 'reddit', 'telegram', 'weibo']);

    const copyBtn = card.querySelector<HTMLButtonElement>('.om-social-share-copy-btn')!;
    await act(async () => {
      copyBtn.click();
    });
    await flush();
    expect(writeText).toHaveBeenCalledWith('Created "Launch Teaser" with OpenMotion: https://open-design.ai/share/teaser');
    expect(onNotify).toHaveBeenCalledWith('Copied share caption', 'info');

    await act(async () => {
      platformButtons[0].click();
    });
    expect(onShared).toHaveBeenCalledWith('x');
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://x.com/intent/tweet?'),
      '_blank',
      'noopener,noreferrer',
    );
  });
});
