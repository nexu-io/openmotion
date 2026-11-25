// Super Agent reports one result per send or stop, as page_name=creative_studio with studio_id=super-agent like its page view.
// Prompts, hidden instructions, attachments, file paths and titles never leave the browser: only the mode, the Agent
// engine id, the chosen model id, counts and fixed categories do. An id outside the bounded rules is left out.
import { uuid } from '../../../tracking/core.ts';
import { send, slugField, type Fields } from '../motion/reporting';

type Turn = Fields<'super_agent_turn_result'>;
const modelId = /^[A-Za-z0-9_.-]{1,128}$/;

export type SuperAgentTurnContext = {
  mode?: string | null;
  chatId?: string | null;
  engine: string;
  model: string;
  permissionMode: 'on-request' | 'auto';
  attachmentCount?: number;
  contextTagCount?: number;
  handoff?: boolean;
};

function contextFields(context: SuperAgentTurnContext) {
  return {
    page_name: 'creative_studio' as const, studio_id: 'super-agent',
    ...slugField('scene_id', context.mode ?? undefined),
    ...(context.chatId && uuid.test(context.chatId) ? { chat_id: context.chatId.toLowerCase() } : {}),
    ...slugField('agent_engine', context.engine),
    // `default` means the engine picks its own model, which is still worth separating from an explicit choice.
    ...(modelId.test(context.model) ? { model_id: context.model } : {}),
    permission_mode: context.permissionMode === 'auto' ? 'auto' as const : 'on_request' as const,
  };
}

/** A send from the composer (or an automatic hand-off), once the service accepted or rejected the turn. */
export function reportSuperAgentSend(turnKind: NonNullable<Turn['turn_kind']>, outcome: Turn['outcome'], context: SuperAgentTurnContext) {
  send('super_agent_turn_result', {
    ...contextFields(context), action: 'send', turn_kind: turnKind, outcome,
    attachment_count: Math.max(0, Math.trunc(context.attachmentCount ?? 0)),
    context_tag_count: Math.max(0, Math.trunc(context.contextTagCount ?? 0)),
    handoff: Boolean(context.handoff),
  });
}

/** The Stop control, once the service answered. */
export function reportSuperAgentStop(outcome: Turn['outcome'], context: SuperAgentTurnContext) {
  send('super_agent_turn_result', { ...contextFields(context), action: 'stop', outcome });
}
