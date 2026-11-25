import type { SuperAgentHandoffPayload } from '../../../shared/capability-hub';
import { pickPreferredLocalAgent, type AgentDirectory } from '../../../shared/local-agents';
import type { SuperAgentChat } from '../../../shared/super-agent';
import { gatewayRequest } from '../motion/gatewayClient';
import { savedPermissionMode } from '../utils/superAgentPreferences';
import { createSuperAgentChat, startSuperAgentTurn } from './superAgentClient';

export type BackgroundSuperAgentTask =
  | { ok: true; chat: SuperAgentChat }
  | { ok: false; reason: 'no-agent' };

/**
 * Starts a Super Agent conversation without leaving the current page.
 * It uses the same Agent the Super Agent page would pick: the default from
 * Settings → Local Agents when it is installed, otherwise the most recently
 * verified installed Agent. Resolves no-agent when none can run.
 */
export async function startBackgroundSuperAgentTask(payload: SuperAgentHandoffPayload): Promise<BackgroundSuperAgentTask> {
  const directory = await gatewayRequest<AgentDirectory>('settings/agents');
  const agents = Array.isArray(directory?.agents) ? directory.agents : [];
  const agent = pickPreferredLocalAgent(agents, directory?.default ?? null);
  if (!agent) return { ok: false, reason: 'no-agent' };
  const choice = directory.default?.agent === agent.id ? directory.default : null;
  const model = choice?.model?.trim() || 'default';
  const reasoning = choice?.reasoning?.trim() || 'default';
  const permissionMode = savedPermissionMode();
  const created = await createSuperAgentChat({
    engine: agent.id,
    ...(model !== 'default' ? { model } : {}),
    permissionMode,
    ...(payload.title ? { title: payload.title } : {}),
  });
  const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `sa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await startSuperAgentTurn(created.conversation.id, {
    requestId,
    text: payload.prompt,
    ...(payload.hiddenInstructions?.trim() ? { hiddenInstructions: payload.hiddenInstructions.trim() } : {}),
    ...(payload.contextTags?.length ? { contextTags: payload.contextTags } : {}),
    ...(payload.mode ? { mode: payload.mode } : {}),
    engine: agent.id,
    model,
    reasoning,
    permissionMode,
    attachments: payload.attachments ?? [],
  });
  return { ok: true, chat: result.conversation ?? created.conversation };
}
