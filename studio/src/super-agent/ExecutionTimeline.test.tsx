// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuperAgentActionCard, SuperAgentChat } from '../../../shared/super-agent';
import { I18nProvider } from '../i18n/I18n';
import { workspacePageHref } from '../motion/workspacePageRouting';
import { ExecutionTimeline } from './ExecutionTimeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

function chatWithCards(cards: SuperAgentActionCard[]): SuperAgentChat {
  const now = Date.now();
  return {
    id: 'chat-action-cards',
    title: 'Game with art',
    engine: 'codex',
    model: 'default',
    reasoning: 'default',
    permissionMode: 'on-request',
    state: 'idle',
    createdAt: now,
    updatedAt: now,
    messages: [
      { id: 'u1', role: 'user', text: 'Make an anime RPG', createdAt: now },
      ...cards.map((card, idx) => ({
        id: `tool:call-${idx}`,
        role: 'tool' as const,
        text: 'openmotion_open_preview',
        createdAt: now + idx + 1,
        toolEvent: {
          callId: `call-${idx}`,
          tool: 'openmotion_open_preview',
          label: 'Open settings',
          status: 'completed' as const,
          actionCard: card,
          startedAt: now + idx + 1,
          finishedAt: now + idx + 2,
        },
      })),
      { id: 'a1', role: 'assistant', text: 'Please sign in or upgrade to continue.', createdAt: now + 10 },
    ],
    artifacts: [],
    approvals: [],
  };
}

describe('ExecutionTimeline inline action cards', () => {
  it('renders deduplicated onboarding/top-up action cards and fires callback on click', async () => {
    const onTriggerActionCard = vi.fn();
    const cards: SuperAgentActionCard[] = [
      { id: 'c1', kind: 'sign_in', entry: 'agent_media_signed_out', provider: 'account' },
      { id: 'c1-dup', kind: 'sign_in', entry: 'agent_media_signed_out', provider: 'account' },
      { id: 'c2', kind: 'upgrade_go', entry: 'agent_media_upgrade_go', provider: 'account' },
      { id: 'c3', kind: 'top_up', entry: 'agent_media_balance_low', provider: 'account' },
    ];

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <ExecutionTimeline
            chat={chatWithCards(cards)}
            busy={false}
            sending={false}
            onOpenArtifactId={vi.fn()}
            onPreviewAttachment={vi.fn()}
            onCopyText={vi.fn()}
            onApprove={vi.fn()}
            onTriggerActionCard={onTriggerActionCard}
          />
        </I18nProvider>,
      );
    });

    const renderedCards = container.querySelectorAll('.om-sa-action-card');
    expect(renderedCards).toHaveLength(3);
    expect(container.textContent).toContain('Sign in with OpenDesign');
    expect(container.textContent).toContain('Upgrade to OpenDesign Plus');
    expect(container.textContent).toContain('Top up OpenDesign balance');

    const signInBtn = Array.from(container.querySelectorAll('button')).find(btn => btn.textContent?.trim() === 'Sign in');
    expect(signInBtn).toBeTruthy();
    expect(signInBtn?.getAttribute('aria-describedby')).toBeTruthy();
    await act(async () => {
      signInBtn!.click();
    });
    expect(onTriggerActionCard).toHaveBeenCalledWith(cards[1]);
  });

  it('suppresses redundant generic sign_in cards when web_publish_sign_in is present in the same turn', async () => {
    const onTriggerActionCard = vi.fn();
    const cards: SuperAgentActionCard[] = [
      { id: 'pub-1', kind: 'web_publish_sign_in', entry: 'agent_media_signed_out', provider: 'account', targetKind: 'game', targetId: 'g-1' },
      { id: 'gen-1', kind: 'sign_in', entry: 'agent_media_signed_out', provider: 'account' },
    ];

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <ExecutionTimeline
            chat={chatWithCards(cards)}
            busy={false}
            sending={false}
            onOpenArtifactId={vi.fn()}
            onPreviewAttachment={vi.fn()}
            onCopyText={vi.fn()}
            onApprove={vi.fn()}
            onTriggerActionCard={onTriggerActionCard}
          />
        </I18nProvider>,
      );
    });

    const renderedCards = container.querySelectorAll('.om-sa-action-card');
    expect(renderedCards).toHaveLength(1);
    expect(renderedCards[0]?.getAttribute('data-kind')).toBe('web_publish_sign_in');
    expect(container.textContent).toContain('Sign in to publish online');

    const publishBtn = Array.from(container.querySelectorAll('button')).find(btn => btn.textContent?.trim() === 'Sign in & publish');
    expect(publishBtn).toBeTruthy();
    await act(async () => {
      publishBtn!.click();
    });
    expect(onTriggerActionCard).toHaveBeenCalledWith(cards[0]);
  });

  it('suppresses stale action cards on older turns once a newer turn exists', async () => {
    const now = Date.now();
    const multiTurnChat: SuperAgentChat = {
      id: 'chat-multi-turn',
      title: 'Game follow-up',
      engine: 'codex',
      model: 'default',
      reasoning: 'default',
      permissionMode: 'on-request',
      state: 'idle',
      createdAt: now,
      updatedAt: now + 50,
      messages: [
        { id: 'u1', role: 'user', text: 'Make a character RPG', createdAt: now },
        {
          id: 'tool:c1',
          role: 'tool',
          text: 'openmotion_open_preview',
          createdAt: now + 1,
          toolEvent: {
            callId: 'c1',
            tool: 'openmotion_open_preview',
            label: 'Open settings',
            status: 'completed',
            actionCard: { id: 'old-sign-in', kind: 'sign_in', entry: 'agent_media_signed_out', provider: 'account' },
            startedAt: now + 1,
            finishedAt: now + 2,
          },
        },
        { id: 'a1', role: 'assistant', text: 'Sign in first.', createdAt: now + 5 },
        { id: 'u2', role: 'user', text: 'Done, continue!', createdAt: now + 10 },
        { id: 'a2', role: 'assistant', text: 'Generating art now.', createdAt: now + 15 },
      ],
      artifacts: [],
      approvals: [],
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <ExecutionTimeline
            chat={multiTurnChat}
            busy={false}
            sending={false}
            onOpenArtifactId={vi.fn()}
            onPreviewAttachment={vi.fn()}
            onCopyText={vi.fn()}
            onApprove={vi.fn()}
            onTriggerActionCard={vi.fn()}
          />
        </I18nProvider>,
      );
    });

    expect(container.querySelectorAll('.om-sa-action-card')).toHaveLength(0);
  });

  it('sets entry_from when routing to provider settings from an action card', () => {
    const href = workspacePageHref('http://localhost/studios/game', {
      settings: 'providers',
      provider: 'account',
      entryFrom: 'agent_media_upgrade_free',
    });
    expect(href).toBe('/settings/providers?entry_from=agent_media_upgrade_free&provider=account');
  });
});
