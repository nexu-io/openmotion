import type { SuperAgentHandoffPayload } from '../../../shared/capability-hub';

/**
 * `/agent?prompt=…[&mode=game]` opens a new Super Agent chat with the
 * prompt filled into the composer. It is never sent automatically: the user
 * reviews it and presses send. External Agents use this to hand a task (for
 * example a game Remix from an Open Design Cloud share) to Super Agent.
 */
export const SUPER_AGENT_PROMPT_PARAMS = ['prompt', 'mode'] as const;
const MAX_PROMPT = 8000;
const MODES = new Set<NonNullable<SuperAgentHandoffPayload['mode']>>(['game', 'website', 'motion', 'deck', 'image', 'media', 'audio']);

export function readSuperAgentPromptLink(search: string): SuperAgentHandoffPayload | null {
  const params = new URLSearchParams(search);
  const prompt = params.get('prompt')?.trim();
  if (!prompt) return null;
  const mode = params.get('mode') as SuperAgentHandoffPayload['mode'] | null;
  return {
    prompt: prompt.slice(0, MAX_PROMPT),
    ...(mode && MODES.has(mode) ? { mode } : {}),
    newChat: true,
    autoSend: false,
  };
}

/** The same address without the one-shot prompt parameters. */
export function withoutSuperAgentPromptLink(href: string): string {
  const url = new URL(href);
  for (const key of SUPER_AGENT_PROMPT_PARAMS) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}
